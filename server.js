const express    = require("express");
const mysql      = require("mysql2");
const bodyParser = require("body-parser");
const multer     = require("multer");
const cors       = require("cors");
const axios      = require("axios");

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// =========================================================================
// EMAILJS CONFIGURATION (HTTP API)
// =========================================================================
const EMAILJS_SERVICE_ID  = process.env.EMAILJS_SERVICE_ID  || "service_2827kk4";
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || "template_rqv959g";
const EMAILJS_PUBLIC_KEY  = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

/** Helper to send OTP via EmailJS API */
async function sendOTPEmail(email, otp) {
  const expiryDate = new Date(Date.now() + 15 * 60 * 1000);
  const timeString = expiryDate.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  const payload = {
    service_id: EMAILJS_SERVICE_ID,
    template_id: EMAILJS_TEMPLATE_ID,
    user_id: EMAILJS_PUBLIC_KEY,
    accessToken: EMAILJS_PRIVATE_KEY,
    template_params: {
      email: email,       // Matches {{email}} in "To Email"
      passcode: otp,      // Matches {{passcode}} in email body
      time: timeString,   // Matches {{time}} in email body
    },
  };

  const response = await axios.post(
    "https://api.emailjs.com/api/v1.0/email/send",
    payload,
    {
      headers: { "Content-Type": "application/json" },
    }
  );

  return response.data;
}

// (Delete duplicate sendOtpEmail function)

// =========================================================================
// DATABASE CONNECTION (TiDB Cloud / Local MySQL)
// =========================================================================
const connection = mysql.createPool({
    host:            process.env.DB_HOST || "gateway01.ap-southeast-1.prod.aws.tidbcloud.com",
    user:            process.env.DB_USER || "2T1X5iT9EJQMbFj.root",
    password:        process.env.DB_PASSWORD || "zRjZw4shNKY2eMpv",
    database:        process.env.DB_NAME || "ce_connect",
    port:            process.env.DB_PORT || 4000,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit:      0,
    ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true
    }
});

connection.getConnection((err, conn) => {
    if (err) {
        console.error("Error connecting to TiDB cloud database:", err.message);
        return;
    }
    console.log("Connected to TiDB Cloud (ce_connect) database successfully!");
    conn.release();
});

// =========================================================================
// MULTER (MEMORY STORAGE FOR BLOB DATA)
// =========================================================================
const storage = multer.memoryStorage();
const upload  = multer({ storage: storage });

// =========================================================================
// IN-MEMORY OTP STORE
// =========================================================================
const otpStore = new Map();

// =========================================================================
// HELPERS
// =========================================================================

/** Generate a secure 6-digit OTP */
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/** Validate Marwadi email domain */
function isValidMarwadiEmail(email) {
    if (!email) return false;
    return /^[^@\s]+@marwadiuniversity\.[^\s]+$/i.test(email.trim());
}


// =========================================================================
// 1. PUBLIC LANDING PAGE API
// =========================================================================

/**
 * FETCH ALL LIVE POSTS (Includes category support)
 */
app.get("/posts", (req, res) => {
    const sql = `
        SELECT p.post_id, p.title, p.post_description, p.category, p.banner_data, p.banner_name, 
               p.created_date, u.full_name as author 
        FROM post p
        JOIN uploader u ON p.uploader_id = u.university_id
        ORDER BY p.created_date DESC
    `;
    connection.query(sql, (err, results) => {
        if (err) {
            console.error("Error fetching posts:", err);
            return res.status(500).json({ error: "Database error fetching posts" });
        }
        const formattedPosts = results.map(post => ({
            id:          post.post_id,
            title:       post.title,
            description: post.post_description,
            category:    post.category || 'General',
            author:      post.author,
            date:        post.created_date,
            image:       post.banner_data ? post.banner_data.toString("base64") : null,
            imageName:   post.banner_name,
        }));
        res.status(200).json(formattedPosts);
    });
});

// =========================================================================
// 2. STUDENT PIPELINE API
// =========================================================================

/**
 * SUBMIT POST REQUEST (Includes student category choice)
 */
app.post("/student/request", upload.single("banner_file"), (req, res) => {
    const { enrollment_no, gr_no, email, phone, name, title, description, category } = req.body;

    if (!isValidMarwadiEmail(email)) {
        return res.status(400).json({
            error: "Invalid email. Students and alumni must use a @marwadiuniversity domain email.",
        });
    }

    const otpRecord = otpStore.get(email);
    if (!otpRecord || !otpRecord.verified) {
        return res.status(403).json({
            error: "Email OTP verification required before submitting a post request.",
        });
    }

    if (otpRecord.verifiedAt && (Date.now() - otpRecord.verifiedAt) > 15 * 60 * 1000) {
        otpStore.delete(email);
        return res.status(403).json({ error: "OTP session expired. Please verify your email again." });
    }

    const bannerData = req.file ? req.file.buffer : null;
    const bannerName = req.file ? req.file.originalname : null;
    const postCategory = category || 'General';

    const sql = `
        INSERT INTO student_post_request 
        (user_enrollment_no, gr_no, university_mail, phone_number, full_name, post_title, post_description, category, banner_data, banner_name) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    connection.query(sql, [enrollment_no, gr_no, email, phone, name, title, description, postCategory, bannerData, bannerName], (err, result) => {
        if (err) {
            console.error("Error creating student request:", err);
            return res.status(500).json({ error: "Failed to submit request" });
        }
        otpStore.delete(email);
        res.status(201).json({ message: "Request generated successfully!", requestId: result.insertId });
    });
});

// =========================================================================
// 3. OTP AUTHENTICATION API
// =========================================================================

app.post("/faculty/send-otp", async (req, res) => {
    const { email } = req.body;

    if (!isValidMarwadiEmail(email)) {
        return res.status(400).json({
            error: "Invalid email. Must be from @marwadiuniversity domain (e.g. @marwadiuniversity.edu.in or @marwadiuniversity.ac.in).",
        });
    }

    const existing = otpStore.get(email);

    if (existing && existing.lockUntil && existing.lockUntil > Date.now()) {
        const remaining = Math.ceil((existing.lockUntil - Date.now()) / 1000 / 60);
        return res.status(429).json({
            error: `Account temporarily locked. Try again after ${remaining} minute${remaining > 1 ? "s" : ""}.`,
            lockUntil: existing.lockUntil,
        });
    }

    if (existing && existing.sentAt && (Date.now() - existing.sentAt) < 60000) {
        const waitSeconds = Math.ceil((60000 - (Date.now() - existing.sentAt)) / 1000);
        return res.status(429).json({
            error: `Please wait ${waitSeconds} second${waitSeconds !== 1 ? "s" : ""} before resending.`,
            waitSeconds,
        });
    }

    const otp    = generateOTP();
    const expiry = Date.now() + 10 * 60 * 1000;

    otpStore.set(email, {
        otp,
        expiry,
        attempts:   0,
        sentAt:     Date.now(),
        lockUntil:  null,
        verified:   false,
        verifiedAt: null,
    });

    try {
        await sendOTPEmail(email, otp);
        console.log(`OTP sent to ${email}`);
        res.status(200).json({ message: "OTP sent successfully to your email." });
    } catch (emailErr) {
        console.error("Email send error:", emailErr.message);
        otpStore.delete(email);
        res.status(500).json({
            error: "Failed to send OTP email. Please check the server EMAIL configuration in server.js.",
        });
    }
});

app.post("/faculty/verify-otp", (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ error: "Email and OTP are required." });
    }

    const record = otpStore.get(email);

    if (!record) {
        return res.status(400).json({ error: "No OTP found for this email. Please request a new OTP." });
    }

    if (record.lockUntil && record.lockUntil > Date.now()) {
        const remaining = Math.ceil((record.lockUntil - Date.now()) / 1000 / 60);
        return res.status(429).json({
            error: `Account locked. Try again after ${remaining} minute${remaining > 1 ? "s" : ""}.`,
            lockUntil: record.lockUntil,
        });
    }

    if (record.expiry < Date.now()) {
        otpStore.delete(email);
        return res.status(400).json({ error: "OTP has expired. Please request a new one." });
    }

    if (record.otp !== otp.trim()) {
        record.attempts += 1;

        if (record.attempts >= 3) {
            record.lockUntil = Date.now() + 5 * 60 * 1000;
            otpStore.set(email, record);
            return res.status(429).json({
                error: "3 incorrect attempts. Please try again after 5 minutes.",
                lockUntil: record.lockUntil,
                attemptsLeft: 0,
            });
        }

        otpStore.set(email, record);
        const attemptsLeft = 3 - record.attempts;
        return res.status(400).json({
            error: `Incorrect OTP. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} remaining.`,
            attemptsLeft,
        });
    }

    record.verified   = true;
    record.verifiedAt = Date.now();
    otpStore.set(email, record);

    res.status(200).json({ message: "Email verified successfully! Proceeding with registration." });
});

// =========================================================================
// 4. FACULTY MANAGEMENT & AUTHENTICATION API
// =========================================================================

app.post("/faculty/register", upload.single("profile_pic"), (req, res) => {
    const { university_id, full_name, role, phone_number, email, password, dob } = req.body;

    if (!isValidMarwadiEmail(email)) {
        return res.status(400).json({ error: "Email must be from @marwadiuniversity domain." });
    }

    const otpRecord = otpStore.get(email);
    if (!otpRecord || !otpRecord.verified) {
        return res.status(403).json({ error: "Email OTP verification required before registration." });
    }

    if (otpRecord.verifiedAt && (Date.now() - otpRecord.verifiedAt) > 15 * 60 * 1000) {
        otpStore.delete(email);
        return res.status(403).json({ error: "OTP session expired. Please verify your email again." });
    }

    const picData = req.file ? req.file.buffer : null;
    const picName = req.file ? req.file.originalname : null;

    const sql = `
        INSERT INTO uploader 
        (university_id, full_name, role, profile_picture_data, profile_picture_name, phone_number, university_email, password_hash, dob) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    connection.query(sql, [university_id, full_name, role, picData, picName, phone_number, email, password, dob], (err) => {
        if (err) {
            console.error("Registration error:", err);
            return res.status(500).json({ error: "Registration failed. ID or email might already exist." });
        }
        otpStore.delete(email);
        res.status(201).json({ message: "Faculty profile registered successfully!" });
    });
});

app.post("/faculty/login", (req, res) => {
    const { email, password } = req.body;

    if (!isValidMarwadiEmail(email)) {
        return res.status(400).json({ error: "Invalid email. Must be from @marwadiuniversity domain." });
    }

    const sql = "SELECT university_id, full_name, role FROM uploader WHERE university_email = ? AND password_hash = ?";
    connection.query(sql, [email, password], (err, results) => {
        if (err) {
            console.error("Login error:", err);
            return res.status(500).json({ error: "Internal server error" });
        }
        if (results.length > 0) {
            res.status(200).json({ message: "Login successful!", user: results[0] });
        } else {
            res.status(401).json({ error: "Invalid email or password." });
        }
    });
});

/**
 * CREATE DIRECT POST (FACULTY) - Includes Category
 */
app.post("/faculty/direct-post", upload.single("banner_file"), (req, res) => {
    const { uploader_id, title, description, category } = req.body;
    const bannerData = req.file ? req.file.buffer : null;
    const bannerName = req.file ? req.file.originalname : null;
    const postCategory = category || 'General';

    const sql = `
        INSERT INTO post 
        (uploader_id, title, post_description, category, banner_data, banner_name, is_student_related) 
        VALUES (?, ?, ?, ?, ?, ?, FALSE)
    `;
    connection.query(sql, [uploader_id, title, description, postCategory, bannerData, bannerName], (err) => {
        if (err) {
            console.error("Direct post creation error:", err);
            return res.status(500).json({ error: "Failed to publish post" });
        }
        res.status(201).json({ message: "Post published successfully!" });
    });
});

/**
 * REJECT STUDENT REQUEST
 */
app.post("/faculty/reject/:requestId", (req, res) => {
    const { requestId } = req.params;
    const sql = "UPDATE student_post_request SET status = 'rejected' WHERE request_id = ?";
    connection.query(sql, [requestId], (err) => {
        if (err) {
            console.error("Rejection error:", err);
            return res.status(500).json({ error: "Failed to reject request" });
        }
        res.status(200).json({ message: "Request has been rejected." });
    });
});

/**
 * DELETE LIVE POST
 */
app.delete("/faculty/delete-post/:postId", (req, res) => {
    const { postId } = req.params;
    const sql = "DELETE FROM post WHERE post_id = ?";
    connection.query(sql, [postId], (err) => {
        if (err) {
            console.error("Database deletion error:", err);
            return res.status(500).json({ error: "Failed to delete post from database" });
        }
        res.status(200).json({ message: "Post removed from live feed successfully!" });
    });
});

// =========================================================================
// 5. FACULTY DASHBOARD PIPELINE (APPROVAL SYSTEM)
// =========================================================================

/**
 * GET PENDING REQUESTS (Includes Category)
 */
app.get("/faculty/pending-requests", (req, res) => {
    const sql = "SELECT * FROM student_post_request WHERE status = 'pending' ORDER BY created_at DESC";
    connection.query(sql, (err, results) => {
        if (err) {
            console.error("Error fetching requests:", err);
            return res.status(500).json({ error: "Failed to fetch pending queue" });
        }
        const formattedRequests = results.map(reqRow => ({
            id:            reqRow.request_id,
            enrollment_no: reqRow.user_enrollment_no,
            gr_no:         reqRow.gr_no,
            name:          reqRow.full_name,
            email:         reqRow.university_mail,
            title:         reqRow.post_title,
            description:   reqRow.post_description,
            category:      reqRow.category || 'General',
            image:         reqRow.banner_data ? reqRow.banner_data.toString("base64") : null,
        }));
        res.status(200).json(formattedRequests);
    });
});

/**
 * APPROVE STUDENT REQUEST
 * Supports category editing by faculty during approval
 */
app.post("/faculty/approve/:requestId", (req, res) => {
    const { requestId }   = req.params;
    const { uploader_id, category } = req.body;

    const selectSql = "SELECT * FROM student_post_request WHERE request_id = ?";
    connection.query(selectSql, [requestId], (err, results) => {
        if (err || results.length === 0) {
            return res.status(404).json({ error: "Target request application not found" });
        }
        const requestData = results[0];

        const finalCategory = category || requestData.category || 'General';

        const insertPostSql = `
            INSERT INTO post 
            (uploader_id, title, post_description, category, banner_data, banner_name, is_student_related, student_id_reference, student_gr_reference, student_name_reference) 
            VALUES (?, ?, ?, ?, ?, ?, TRUE, ?, ?, ?)
        `;
        connection.query(insertPostSql, [
            uploader_id,
            requestData.post_title,
            requestData.post_description,
            finalCategory,
            requestData.banner_data,
            requestData.banner_name,
            requestData.user_enrollment_no,
            requestData.gr_no,
            requestData.full_name,
        ], (err) => {
            if (err) {
                console.error("Migration error during approval:", err);
                return res.status(500).json({ error: "Failed to push request to active post table" });
            }

            const updateStatusSql = "UPDATE student_post_request SET status = 'approved', category = ? WHERE request_id = ?";
            connection.query(updateStatusSql, [finalCategory, requestId], () => {
                res.status(200).json({ message: "Post approved and added to newsletter feed successfully!" });
            });
        });
    });
});

// =========================================================================
// 6. ADMIN PANEL API
// =========================================================================

/**
 * ADMIN LOGIN
 */
app.post("/admin/login", (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required." });
    }
    const sql = "SELECT admin_id, email, full_name FROM admin WHERE email = ? AND password_hash = ?";
    connection.query(sql, [email, password], (err, results) => {
        if (err) {
            console.error("Admin login error:", err);
            return res.status(500).json({ error: "Internal server error" });
        }
        if (results.length > 0) {
            res.status(200).json({ message: "Admin login successful!", admin: results[0] });
        } else {
            res.status(401).json({ error: "Invalid admin credentials." });
        }
    });
});

/**
 * GET ALL FACULTY
 */
app.get("/admin/faculty", (req, res) => {
    const sql = "SELECT university_id, full_name, role, university_email, phone_number, dob, profile_picture_data, profile_picture_name FROM uploader ORDER BY full_name ASC";
    connection.query(sql, (err, results) => {
        if (err) {
            console.error("Error fetching faculty:", err);
            return res.status(500).json({ error: "Failed to fetch faculty list" });
        }
        const faculty = results.map(f => ({
            university_id: f.university_id,
            full_name:     f.full_name,
            role:          f.role,
            email:         f.university_email,
            phone:         f.phone_number,
            dob:           f.dob,
            hasPhoto:      !!f.profile_picture_data,
        }));
        res.status(200).json(faculty);
    });
});

/**
 * ADD FACULTY (Admin bypass - no OTP required)
 */
app.post("/admin/faculty/add", upload.single("profile_pic"), (req, res) => {
    const { university_id, full_name, role, phone_number, email, password, dob } = req.body;
    if (!university_id || !full_name || !email || !password) {
        return res.status(400).json({ error: "university_id, full_name, email and password are required." });
    }
    const picData = req.file ? req.file.buffer : null;
    const picName = req.file ? req.file.originalname : null;
    const sql = `
        INSERT INTO uploader 
        (university_id, full_name, role, profile_picture_data, profile_picture_name, phone_number, university_email, password_hash, dob) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    connection.query(sql, [university_id, full_name, role || 'Faculty', picData, picName, phone_number, email, password, dob], (err) => {
        if (err) {
            console.error("Admin add faculty error:", err);
            return res.status(500).json({ error: "Failed to add faculty. ID or email might already exist." });
        }
        res.status(201).json({ message: "Faculty member added successfully!" });
    });
});

/**
 * DELETE FACULTY
 */
app.delete("/admin/faculty/:id", (req, res) => {
    const { id } = req.params;
    const sql = "DELETE FROM uploader WHERE university_id = ?";
    connection.query(sql, [id], (err, result) => {
        if (err) {
            console.error("Admin delete faculty error:", err);
            return res.status(500).json({ error: "Failed to delete faculty member" });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Faculty member not found" });
        }
        res.status(200).json({ message: "Faculty member removed successfully!" });
    });
});

/**
 * GET ALL POSTS (Admin - includes all metadata)
 */
app.get("/admin/posts", (req, res) => {
    const sql = `
        SELECT p.post_id, p.title, p.post_description, p.category, p.banner_data, p.banner_name,
               p.created_date, p.is_student_related, p.student_name_reference,
               u.full_name as author, u.university_email as author_email
        FROM post p
        JOIN uploader u ON p.uploader_id = u.university_id
        ORDER BY p.created_date DESC
    `;
    connection.query(sql, (err, results) => {
        if (err) {
            console.error("Admin fetch posts error:", err);
            return res.status(500).json({ error: "Failed to fetch posts" });
        }
        res.status(200).json(results.map(p => ({
            post_id:              p.post_id,
            title:                p.title,
            description:          p.post_description,
            category:             p.category || 'General',
            author:               p.author,
            author_email:         p.author_email,
            date:                 p.created_date,
            is_student_related:   p.is_student_related,
            student_name:         p.student_name_reference,
            banner_name:          p.banner_name,
            image:                p.banner_data ? p.banner_data.toString('base64') : null,
        })));
    });
});

/**
 * DELETE POST (Admin)
 */
app.delete("/admin/posts/:id", (req, res) => {
    const { id } = req.params;
    const sql = "DELETE FROM post WHERE post_id = ?";
    connection.query(sql, [id], (err, result) => {
        if (err) {
            console.error("Admin delete post error:", err);
            return res.status(500).json({ error: "Failed to delete post" });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Post not found" });
        }
        res.status(200).json({ message: "Post deleted successfully!" });
    });
});

/**
 * GET ALL STUDENT REQUESTS (Admin - all statuses)
 */
app.get("/admin/requests", (req, res) => {
    const sql = "SELECT * FROM student_post_request ORDER BY created_at DESC";
    connection.query(sql, (err, results) => {
        if (err) {
            console.error("Admin fetch requests error:", err);
            return res.status(500).json({ error: "Failed to fetch requests" });
        }
        res.status(200).json(results.map(r => ({
            id:            r.request_id,
            enrollment_no: r.user_enrollment_no,
            gr_no:         r.gr_no,
            name:          r.full_name,
            email:         r.university_mail,
            title:         r.post_title,
            description:   r.post_description,
            category:      r.category || 'General',
            status:        r.status,
            created_at:    r.created_at,
        })));
    });
});

/**
 * DELETE STUDENT REQUEST (Admin)
 */
app.delete("/admin/requests/:id", (req, res) => {
    const { id } = req.params;
    const sql = "DELETE FROM student_post_request WHERE request_id = ?";
    connection.query(sql, [id], (err, result) => {
        if (err) {
            console.error("Admin delete request error:", err);
            return res.status(500).json({ error: "Failed to delete request" });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Request not found" });
        }
        res.status(200).json({ message: "Request deleted successfully!" });
    });
});

/**
 * ANALYTICS (Admin)
 */
app.get("/admin/analytics", (req, res) => {
    const queries = {
        totalPosts:       "SELECT COUNT(*) as count FROM post",
        totalFaculty:     "SELECT COUNT(*) as count FROM uploader",
        totalRequests:    "SELECT COUNT(*) as count FROM student_post_request",
        pendingRequests:  "SELECT COUNT(*) as count FROM student_post_request WHERE status = 'pending'",
        approvedRequests: "SELECT COUNT(*) as count FROM student_post_request WHERE status = 'approved'",
        rejectedRequests: "SELECT COUNT(*) as count FROM student_post_request WHERE status = 'rejected'",
        postsByCategory:  "SELECT category, COUNT(*) as count FROM post GROUP BY category ORDER BY count DESC",
        postsByDay:       `SELECT DATE(created_date) as day, COUNT(*) as count 
                           FROM post 
                           WHERE created_date >= DATE_SUB(NOW(), INTERVAL 30 DAY) 
                           GROUP BY DATE(created_date) 
                           ORDER BY day ASC`,
        recentPosts:      `SELECT p.post_id, p.title, p.category, p.created_date, u.full_name as author 
                           FROM post p 
                           JOIN uploader u ON p.uploader_id = u.university_id 
                           ORDER BY p.created_date DESC LIMIT 5`,
        studentPosts:     "SELECT COUNT(*) as count FROM post WHERE is_student_related = TRUE",
        facultyPosts:     "SELECT COUNT(*) as count FROM post WHERE is_student_related = FALSE",
        postsByMonth:     `SELECT DATE_FORMAT(created_date, '%Y-%m') as month, COUNT(*) as count 
                           FROM post 
                           GROUP BY DATE_FORMAT(created_date, '%Y-%m') 
                           ORDER BY month ASC LIMIT 12`,
    };

    const results = {};
    const keys = Object.keys(queries);
    let completed = 0;
    let hasError = false;

    keys.forEach(key => {
        connection.query(queries[key], (err, rows) => {
            if (hasError) return;
            if (err) {
                hasError = true;
                console.error(`Analytics query error [${key}]:`, err);
                return res.status(500).json({ error: `Failed to run analytics query: ${key}` });
            }
            if (['postsByCategory', 'postsByDay', 'recentPosts', 'postsByMonth'].includes(key)) {
                results[key] = rows;
            } else {
                results[key] = rows[0]?.count || 0;
            }
            completed++;
            if (completed === keys.length) {
                res.status(200).json(results);
            }
        });
    });
});

// =========================================================================
// SERVER START
// =========================================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`CE Connect Backend running on port ${PORT}`);
    console.log(`EmailJS Service ID: ${EMAILJS_SERVICE_ID}`);
});