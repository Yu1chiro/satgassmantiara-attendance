require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const { Pool } = require("pg");
const qrcode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,
    },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const authMiddleware = (req, res, next) => {
    if (req.cookies.authToken === "valid_token") {
        next();
    } else {
        res.status(401).redirect("/login");
    }
};

// --- Rute Halaman (Routes) ---
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/dashboard", authMiddleware, (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/generate", authMiddleware, (req, res) => res.sendFile(path.join(__dirname, "public", "generate.html")));
app.get("/documentation", authMiddleware, (req, res) => res.sendFile(path.join(__dirname, "public", "documentation.html")));
app.get("/riwayat", authMiddleware, (req, res) => res.sendFile(path.join(__dirname, "public", "riwayat.html")));

// --- Rute Formulir Publik ---
app.get('/presensi-tugas-pagi', async (req, res) => {
    try {
        const settings = await pool.query('SELECT is_keamanan_form_active FROM settings WHERE id = 1');
        if (settings.rows[0] && settings.rows[0].is_keamanan_form_active) {
            res.sendFile(path.join(__dirname, 'public', 'keamanan.html'));
        } else {
            res.sendFile(path.join(__dirname, 'public', 'form-closed.html'));
        }
    } catch (error) {
        res.status(500).send("Server error");
    }
});

app.get('/presensi-izin-sakit', async (req, res) => {
    try {
        const settings = await pool.query('SELECT is_izin_form_active FROM settings WHERE id = 1');
        if (settings.rows[0] && settings.rows[0].is_izin_form_active) {
            res.sendFile(path.join(__dirname, 'public', 'berhalangan.html'));
        } else {
            res.sendFile(path.join(__dirname, 'public', 'form-closed.html'));
        }
    } catch (error) {
        res.status(500).send("Server error");
    }
});

// --- API Autentikasi ---
app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        res.cookie("authToken", "valid_token", { httpOnly: true, secure: process.env.NODE_ENV === "production", maxAge: 3600000 });
        res.json({ success: true, message: "Login berhasil!" });
    } else {
        res.status(401).json({ success: false, message: "Username atau password salah." });
    }
});

app.post("/api/logout", (req, res) => {
    res.clearCookie("authToken");
    res.json({ success: true, message: "Logout berhasil." });
});

// --- API Pengaturan (Settings) ---
app.get('/api/settings', authMiddleware, async (req, res) => {
    try {
        // MODIFIKASI DI SINI: Tambahkan is_late_form_active
        const result = await pool.query('SELECT is_active, is_keamanan_form_active, is_izin_form_active, is_late_form_active FROM settings WHERE id = 1');
        res.json(result.rows[0] || {});
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/settings', authMiddleware, async (req, res) => {
    // MODIFIKASI DI SINI: Tambahkan is_late_form_active
    const { is_active, is_keamanan_form_active, is_izin_form_active, is_late_form_active } = req.body;
    try {
        const query = `
            UPDATE settings 
            SET 
                is_active = COALESCE($1, is_active),
                is_keamanan_form_active = COALESCE($2, is_keamanan_form_active),
                is_izin_form_active = COALESCE($3, is_izin_form_active),
                is_late_form_active = COALESCE($4, is_late_form_active) -- MODIFIKASI DI SINI
            WHERE id = 1
        `;
        // MODIFIKASI DI SINI: Tambahkan parameter ke-4
        await pool.query(query, [is_active, is_keamanan_form_active, is_izin_form_active, is_late_form_active]);
        res.json({ success: true, message: 'Pengaturan berhasil diperbarui!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Gagal menyimpan pengaturan.' });
    }
});
app.post('/api/absen-terlambat', async (req, res) => {
    const { nipd, reason } = req.body; // Hanya butuh nipd dan reason
    try {
        const settings = await pool.query('SELECT is_late_form_active FROM settings WHERE id = 1');
        if (!settings.rows[0] || !settings.rows[0].is_late_form_active) {
            return res.status(403).json({ success: false, message: 'Form keterlambatan ini sedang tidak aktif.' });
        }
        
        const memberResult = await pool.query('SELECT full_name FROM satgas_members WHERE nipd = $1', [nipd]);
        if (memberResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: `NIPD Anggota tidak valid.` });
        }
        const memberName = memberResult.rows[0].full_name;

        const insertQuery = `
            INSERT INTO attendance_records (member_id, status, reason, attendance_date) 
            VALUES ($1, 'Terlambat', $2, (NOW() AT TIME ZONE 'Asia/Makassar')::date);
        `;
        await pool.query(insertQuery, [nipd, reason]); // Status 'Terlambat' di-hardcode

        res.json({ success: true, message: `Terima kasih, ${memberName}. Keterangan TERLAMBAT Anda telah kami terima.` });
    
    } catch (err) {
        if (err.code === '23505') {
            const memberResult = await pool.query('SELECT full_name FROM satgas_members WHERE nipd = $1', [nipd]);
            const memberName = memberResult.rows.length ? memberResult.rows[0].full_name : 'Anda';
            return res.status(409).json({ success: false, message: `${memberName} sudah tercatat dalam sistem absensi hari ini.` });
        }
        console.error("Absen terlambat error:", err);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
    }
});
// --- API Anggota (Members) ---
app.get('/api/public/members', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT nipd, full_name FROM satgas_members ORDER BY full_name ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Gagal mengambil data anggota" });
    }
});

app.get('/api/admin/members', authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT nipd, full_name, devisi, jabatan FROM satgas_members ORDER BY full_name ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Gagal mengambil data anggota" });
    }
});

// --- API QR Code ---
app.get('/api/generate-qr', authMiddleware, async (req, res) => {
    const { nipd } = req.query;
    try {
        const dataUrl = await qrcode.toDataURL(nipd, { width: 250 });
        res.json({ qr_code_url: dataUrl });
    } catch (err) {
        res.status(500).json({ error: 'Gagal membuat QR code' });
    }
});

// --- API Absensi (Attendance) ---
app.post('/api/scan', authMiddleware, async (req, res) => {
    const { nipd } = req.body;
    try {
        const settings = await pool.query('SELECT is_active FROM settings WHERE id = 1');
        if (!settings.rows[0] || !settings.rows[0].is_active) {
            return res.status(403).json({ success: false, message: 'Sesi absensi pindai QR sedang ditutup.' });
        }
        
        const memberResult = await pool.query('SELECT full_name FROM satgas_members WHERE nipd = $1', [nipd]);
        if (memberResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: `QR Code tidak valid. NIPD "${nipd}" tidak terdaftar.` });
        }
        const memberName = memberResult.rows[0].full_name;

        const insertQuery = `
            INSERT INTO attendance_records (member_id, status, attendance_date) 
            VALUES ($1, 'Hadir', (NOW() AT TIME ZONE 'Asia/Makassar')::date)
            RETURNING to_char(attendance_time AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') as time;
        `;
        const newRecord = await pool.query(insertQuery, [nipd]);
        const newTime = newRecord.rows[0].time;

        res.json({ success: true, message: `${memberName} berhasil dicatat HADIR!`, time: newTime, nipd: nipd });

    } catch (err) {
        if (err.code === '23505') {
            const memberResult = await pool.query('SELECT full_name FROM satgas_members WHERE nipd = $1', [nipd]);
            const memberName = memberResult.rows.length ? memberResult.rows[0].full_name : 'Anggota ini';
            return res.status(409).json({ success: false, message: `${memberName} sudah tercatat dalam sistem absensi hari ini.` });
        }
        console.error("Scan error:", err);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
    }
});
app.get('/presensi-terlambat', async (req, res) => {
    try {
        const settings = await pool.query('SELECT is_late_form_active FROM settings WHERE id = 1');
        if (settings.rows[0] && settings.rows[0].is_late_form_active) {
            res.sendFile(path.join(__dirname, 'public', 'late.html'));
        } else {
            res.sendFile(path.join(__dirname, 'public', 'form-closed.html'));
        }
    } catch (error) {
        res.status(500).send("Server error");
    }
});
app.post('/api/absen-keamanan', async (req, res) => {
    const { nipd } = req.body;
    try {
        const settings = await pool.query('SELECT is_keamanan_form_active FROM settings WHERE id = 1');
        if (!settings.rows[0] || !settings.rows[0].is_keamanan_form_active) {
            return res.status(403).json({ success: false, message: 'Form absensi ini sedang tidak aktif.' });
        }
        const memberResult = await pool.query('SELECT full_name FROM satgas_members WHERE nipd = $1', [nipd]);
        if (memberResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: `NIPD Anggota tidak valid.` });
        }
        const memberName = memberResult.rows[0].full_name;

        const insertQuery = `
            INSERT INTO attendance_records (member_id, status, attendance_date) 
            VALUES ($1, 'Tugas Pagi', (NOW() AT TIME ZONE 'Asia/Makassar')::date);
        `;
        await pool.query(insertQuery, [nipd]);
        
        res.json({ success: true, message: `Terima kasih, ${memberName}. Kehadiran Tugas Pagi Anda telah dicatat.` });
    } catch (err) {
        if (err.code === '23505') {
            const memberResult = await pool.query('SELECT full_name FROM satgas_members WHERE nipd = $1', [nipd]);
            const memberName = memberResult.rows.length ? memberResult.rows[0].full_name : 'Anda';
            return res.status(409).json({ success: false, message: `${memberName} sudah tercatat dalam sistem absensi hari ini.` });
        }
        console.error("Absen keamanan error:", err);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
    }
});

app.post('/api/absen-berhalangan', async (req, res) => {
    const { nipd, status, reason } = req.body;
    try {
        const settings = await pool.query('SELECT is_izin_form_active FROM settings WHERE id = 1');
        if (!settings.rows[0] || !settings.rows[0].is_izin_form_active) {
            return res.status(403).json({ success: false, message: 'Form absensi ini sedang tidak aktif.' });
        }
        
        const memberResult = await pool.query('SELECT full_name FROM satgas_members WHERE nipd = $1', [nipd]);
        if (memberResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: `NIPD Anggota tidak valid.` });
        }
        const memberName = memberResult.rows[0].full_name;

        const insertQuery = `
            INSERT INTO attendance_records (member_id, status, reason, attendance_date) 
            VALUES ($1, $2, $3, (NOW() AT TIME ZONE 'Asia/Makassar')::date);
        `;
        await pool.query(insertQuery, [nipd, status, reason]);

        res.json({ success: true, message: `Terima kasih, ${memberName}. Keterangan ${status} Anda telah kami terima.` });
    
    } catch (err) {
        if (err.code === '23505') {
            const memberResult = await pool.query('SELECT full_name FROM satgas_members WHERE nipd = $1', [nipd]);
            const memberName = memberResult.rows.length ? memberResult.rows[0].full_name : 'Anda';
            return res.status(409).json({ success: false, message: `${memberName} sudah tercatat dalam sistem absensi hari ini.` });
        }
        console.error("Absen berhalangan error:", err);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
    }
});

// --- API Pencarian & Laporan (Search & Records) ---
app.get("/api/records", authMiddleware, async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "Tanggal diperlukan." });
    try {
        const query = `
            SELECT 
                m.nipd,
                m.full_name, 
                m.devisi,
                m.jabatan,
                r.reason,
                COALESCE(r.status, 'Belum Hadir') as status,
                to_char(r.attendance_time AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') as time
            FROM 
                satgas_members m
            LEFT JOIN 
                attendance_records r ON m.nipd = r.member_id 
                AND (r.attendance_time AT TIME ZONE 'Asia/Makassar')::date = $1
            ORDER BY 
                m.full_name;
        `;
        const { rows } = await pool.query(query, [date]);
        res.json(rows);
    } catch (err) {
        console.error("Error fetching records:", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.delete('/api/records', authMiddleware, async (req, res) => {
    const { date } = req.query;
    if (!date) {
        return res.status(400).json({ success: false, message: 'Tanggal diperlukan untuk mereset data.' });
    }

    try {
        const query = `
            DELETE FROM attendance_records 
            WHERE (attendance_time AT TIME ZONE 'Asia/Makassar')::date = $1
        `;
        const result = await pool.query(query, [date]);
        
        res.json({ success: true, message: `Berhasil mereset ${result.rowCount} data kehadiran untuk tanggal ${date}.` });
    } catch (err) {
        console.error("Error resetting records:", err);
        res.status(500).json({ success: false, message: 'Gagal mereset data kehadiran di database.' });
    }
});

app.get('/api/search', async (req, res) => {
    const { name } = req.query;

    if (!name || name.length < 3) {
        return res.status(400).json({ error: 'Nama harus terdiri dari minimal 3 karakter.' });
    }

    try {
        const query = `
            SELECT 
                m.full_name,
                m.devisi,
                m.jabatan,
                r.status,
                (r.attendance_time AT TIME ZONE 'Asia/Makassar')::date as attendance_date,
                to_char(r.attendance_time AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') as time
            FROM attendance_records r
            JOIN satgas_members m ON r.member_id = m.nipd
            WHERE m.full_name ILIKE $1
            ORDER BY r.attendance_time DESC;
        `;
        const searchTerm = `%${name}%`;
        const { rows } = await pool.query(query, [searchTerm]);
        res.json(rows);
    } catch (err) {
        console.error("Search error:", err);
        res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
    }
});


// --- ENDPOINT UNTUK HALAMAN RIWAYAT (DIREVISI) ---

// 1. Endpoint untuk mengambil daftar bulan unik (YYYY-MM)
app.get('/api/history/dates', authMiddleware, async (req, res) => {
    try {
        const query = `
            SELECT DISTINCT to_char(attendance_time AT TIME ZONE 'Asia/Makassar', 'YYYY-MM') as month
            FROM attendance_records
            ORDER BY month DESC;
        `;
        const { rows } = await pool.query(query);
        res.json(rows.map(row => row.month));
    } catch (err) {
        console.error("Error fetching history dates:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// 2. Endpoint untuk mengambil data laporan berdasarkan filter (DIREVISI)
app.get('/api/history/report', authMiddleware, async (req, res) => {
    // DIUBAH: dari 'jabatan' ke 'devisi'
    const { month, devisi } = req.query; 

    if (!month) {
        return res.status(400).json({ error: "Filter bulan diperlukan." });
    }

    try {
        let queryParams = [month];
        let queryString = `
            SELECT 
                to_char(r.attendance_time AT TIME ZONE 'Asia/Makassar', 'YYYY-MM-DD HH24:MI:SS') as timestamp,
                m.full_name,
                m.jabatan,
                m.devisi, 
                r.status,
                r.reason
            FROM 
                attendance_records r
            JOIN 
                satgas_members m ON r.member_id = m.nipd
            WHERE 
                to_char(r.attendance_time AT TIME ZONE 'Asia/Makassar', 'YYYY-MM') = $1
        `;

        // DIUBAH: filter berdasarkan 'devisi'
        if (devisi && devisi !== 'Semua') {
            queryParams.push(devisi);
            queryString += ` AND m.devisi = $${queryParams.length}`;
        }
        
        queryString += ` ORDER BY r.attendance_time DESC;`;

        const { rows } = await pool.query(queryString, queryParams);
        res.json(rows);
    } catch (err) {
        console.error("Error fetching history report:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// --- Server Listener ---
app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});

