// Import library yang dibutuhkan
require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const { Pool } = require("pg");

// Inisialisasi aplikasi Express
const app = express();
const PORT = process.env.PORT || 3000;

// Konfigurasi koneksi database dari .env
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Middleware
app.use(express.json()); // parsing body JSON
app.use(express.urlencoded({ extended: true })); //  parsing form data
app.use(cookieParser()); // parsing cookies
app.use(express.static(path.join(__dirname, "public"))); 
// (Haversine Formula)
function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Radius bumi dalam meter
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Jarak dalam meter
}

// Middleware auth
const authMiddleware = (req, res, next) => {
  if (req.cookies.authToken === "valid_token") {
    next();
  } else {
    res.status(401).redirect("/login");
  }
};

// --- RUTE HALAMAN ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/attendance", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "attendance.html"));
});
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/dashboard", authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// --- RUTE API ---

// API untuk Login Admin
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    res.cookie("authToken", "valid_token", { httpOnly: true, secure: process.env.NODE_ENV === "production", maxAge: 3600000 }); // Cookie 1 jam
    res.json({ success: true, message: "Login berhasil!" });
  } else {
    res.status(401).json({ success: false, message: "Username atau password salah." });
  }
});

// API untuk Logout Admin
app.post("/api/logout", (req, res) => {
  res.clearCookie("authToken");
  res.json({ success: true, message: "Logout berhasil." });
});

// API untuk mendapatkan pengaturan (lokasi & timer)
app.get('/api/settings', authMiddleware, async (req, res) => {
    try {
        // Ambil juga kolom is_active
        const result = await pool.query('SELECT target_latitude, target_longitude, deadline_time, is_active FROM settings WHERE id = 1');
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ error: 'Pengaturan tidak ditemukan.' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Ganti rute POST /api/settings yang lama
app.post('/api/settings', authMiddleware, async (req, res) => {
    // Ambil juga nilai is_active dari body
    const { latitude, longitude, deadline, is_active } = req.body;
    try {
        const query = `
            UPDATE settings
            SET target_latitude = $1, target_longitude = $2, deadline_time = $3, is_active = $4
            WHERE id = 1
        `;
        await pool.query(query, [latitude, longitude, deadline, is_active]);
        res.json({ success: true, message: 'Pengaturan berhasil disimpan!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Gagal menyimpan pengaturan.' });
    }
});
app.get('/api/attendance-status', async (req, res) => {
    try {
        const result = await pool.query('SELECT is_active, deadline_time FROM settings WHERE id = 1');
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            // Jika tidak ada pengaturan, anggap tidak aktif
            res.json({ is_active: false });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ is_active: false, error: 'Server error' });
    }
});
// API untuk Absensi Tepat Waktu (dengan Geolocation)
app.post("/api/attendance", async (req, res) => {
  const { fullName, studentClass, division, latitude, longitude } = req.body;

  if (!fullName || !studentClass || !division || !latitude || !longitude) {
    return res.status(400).json({ success: false, message: "Semua field harus diisi." });
  }
    const statusResult = await pool.query('SELECT is_active FROM settings WHERE id = 1');
        if (!statusResult.rows[0].is_active) {
            return res.status(403).json({ success: false, message: 'Presensi saat ini sedang ditutup oleh admin.' });
        }
  try {
    const settings = await pool.query("SELECT target_latitude, target_longitude, deadline_time FROM settings WHERE id = 1");

    if (settings.rows.length === 0 || !settings.rows[0].target_latitude || !settings.rows[0].target_longitude) {
      return res.status(400).json({ success: false, message: "Lokasi absensi belum diatur oleh admin." });
    }

    const { target_latitude, target_longitude, deadline_time } = settings.rows[0];

    if (new Date() > new Date(deadline_time)) {
      return res.status(400).json({ success: false, message: "Waktu absensi sudah habis." });
    }

    const distance = getDistanceFromLatLonInMeters(latitude, longitude, parseFloat(target_latitude), parseFloat(target_longitude));

    let attendanceStatus = distance <= 500 ? "Hadir" : "Tidak Hadir";
    let responseStatus = distance <= 500 ? "present" : "absent";
    let responseMessage = distance <= 500 ? `Absensi berhasil! Anda berada ${Math.round(distance)} meter dari lokasi.` : `Anda berada terlalu jauh (${Math.round(distance)} meter). Kehadiran Anda di sistem otomatis TIDAK HADIR.`;

    // --- PERUBAHAN UTAMA: Simpan juga koordinat pengguna ---
    await pool.query(
      `INSERT INTO attendance_records 
            (full_name, student_class, division, status, user_latitude, user_longitude) 
            VALUES ($1, $2, $3, $4, $5, $6)`,
      [fullName, studentClass, division, attendanceStatus, latitude, longitude]
    );

    res.json({ success: true, status: responseStatus, message: responseMessage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Terjadi kesalahan pada server." });
  }
});
// API untuk Absensi Terlambat
app.post("/api/late-attendance", async (req, res) => {
  const { fullName, studentClass, division, reason } = req.body;

  if (!fullName || !studentClass || !division || !reason) {
    return res.status(400).json({ success: false, message: "Semua field harus diisi, termasuk alasan keterlambatan." });
  }

  try {
    await pool.query("INSERT INTO attendance_records (full_name, student_class, division, status, reason) VALUES ($1, $2, $3, $4, $5)", [fullName, studentClass, division, "Terlambat", reason]);
    res.json({ success: true, message: "Catatan keterlambatan Anda berhasil dikirim." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Terjadi kesalahan pada server." });
  }
});

// API untuk mendapatkan data absensi (dengan filter)
app.get("/api/records", authMiddleware, async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: "Tanggal diperlukan." });
  }
  try {
    // --- PERUBAHAN UTAMA: Ambil ID dan koordinat pengguna ---
    const query = `
            SELECT id, full_name, student_class, division, status, reason, 
                   user_latitude, user_longitude,
                   to_char(created_at AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') as time
            FROM attendance_records
            WHERE DATE(created_at AT TIME ZONE 'Asia/Makassar') = $1
            ORDER BY created_at DESC
        `;
    const { rows } = await pool.query(query, [date]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
app.delete("/api/records/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const deleteQuery = "DELETE FROM attendance_records WHERE id = $1";
    const result = await pool.query(deleteQuery, [id]);

    if (result.rowCount > 0) {
      res.json({ success: true, message: "Data berhasil dihapus." });
    } else {
      res.status(404).json({ success: false, message: "Data tidak ditemukan." });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Gagal menghapus data." });
  }
});
// API untuk pencarian siswa
app.get("/api/search", async (req, res) => {
  const { name } = req.query;
  if (!name) {
    return res.status(400).json([]);
  }
  try {
    const query = `
            SELECT full_name, student_class, division, status,
                   to_char(created_at AT TIME ZONE 'Asia/Makassar', 'YYYY-MM-DD HH24:MI') as formatted_date
            FROM attendance_records
            WHERE full_name ILIKE $1
            ORDER BY created_at DESC
            LIMIT 10
        `;
    const { rows } = await pool.query(query, [`%${name}%`]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Menjalankan server
app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
});
