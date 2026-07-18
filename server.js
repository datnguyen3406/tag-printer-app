const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const multer = require('multer');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/templates', express.static('templates'));

let masterDictionary = {}; 
let printQueue = { matched: [], error: [] };

const SETTINGS_FILE = path.join(__dirname, 'config', 'settings.json');
const DATA_DIR = path.join(__dirname, 'data');
const TEMPLATE_DIR = path.join(__dirname, 'templates');

[DATA_DIR, path.join(__dirname, 'config'), TEMPLATE_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const loadExcelToRAM = () => {
    masterDictionary = {}; 
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.xlsx'));
    
    files.forEach(file => {
        try {
            const workbook = xlsx.readFile(path.join(DATA_DIR, file));
            const sheet = workbook.Sheets[workbook.SheetNames[0]]; 
            const data = xlsx.utils.sheet_to_json(sheet);
            
            data.forEach(row => {
                const barcode = row.BARCODE ? String(row.BARCODE).trim() : '';
                if (barcode !== '') {
                    masterDictionary[barcode] = {
                        barcode: barcode,
                        tenSp: String(row['TEN_SP FINAL'] || row['NAME PRODUCT'] || row.TEN_SP || '').trim(),
                        ticket: String(row.TICKET || '0').trim()
                    };
                }
            });
            console.log(`✅ Đã nạp file: ${file}`);
        } catch (err) {
            console.error(`❌ Lỗi đọc file ${file}:`, err);
        }
    });
};
loadExcelToRAM();

const excelStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'data/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const uploadExcel = multer({ storage: excelStorage });

const templateStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'templates/'),
    filename: (req, file, cb) => cb(null, 'bg-' + Date.now() + path.extname(file.originalname))
});
const uploadTemplate = multer({ storage: templateStorage });

// --- [FR-021] API Kiểm tra sức khỏe hệ thống ---
app.get('/api/health', (req, res) => {
    res.json({
        dbCount: Object.keys(masterDictionary).length,
        status: "online"
    });
});

app.post('/api/upload-excel', uploadExcel.array('files'), (req, res) => {
    loadExcelToRAM(); 
    res.json({ message: "Đã tải lên và gộp dữ liệu!", total: Object.keys(masterDictionary).length });
});

app.post('/api/upload-template', uploadTemplate.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ message: "Lỗi file ảnh" });
    res.json({ imageUrl: `/templates/${req.file.filename}` }); 
});

app.get('/api/settings', (req, res) => {
    if (fs.existsSync(SETTINGS_FILE)) res.json(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')));
    else res.json({}); 
});

app.post('/api/settings', (req, res) => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(req.body, null, 2));
    res.json({ message: "Đã lưu cấu hình" });
});

// --- [FR-017] Xử lý Scan và nhận tên gợi ý từ Trạm 1 ---
app.post('/api/scan', (req, res) => {
    const { barcode, suggestedName } = req.body;
    const scannedBarcode = (barcode || '').trim();
    if (!scannedBarcode) return res.status(400).json({ message: "Mã vạch trống!" });

    const foundProduct = masterDictionary[scannedBarcode]; 
    if (foundProduct) {
        printQueue.matched.push({ id: Date.now(), ...foundProduct });
        res.status(200).json({ success: true, message: "Hợp lệ" });
    } else {
        const existingError = printQueue.error.find(e => e.barcode === scannedBarcode);
        if (existingError && suggestedName) {
            existingError.suggestedName = suggestedName; // Cập nhật tên nếu Trạm 1 gửi lên
        } else if (!existingError) {
            printQueue.error.push({ id: Date.now(), barcode: scannedBarcode, suggestedName: suggestedName || '' });
        }
        res.status(200).json({ success: false, message: "Lỗi mã" });
    }
});

app.get('/api/queue', (req, res) => res.json(printQueue));

app.post('/api/clear-queue', (req, res) => {
    printQueue = { matched: [], error: [] };
    res.json({ message: "Đã dọn dẹp" });
});

app.post('/api/remove-item', (req, res) => {
    const { id, type } = req.body;
    if (type === 'matched') printQueue.matched = printQueue.matched.filter(item => item.id !== id);
    else if (type === 'error') printQueue.error = printQueue.error.filter(item => item.id !== id);
    res.json({ message: "Đã xóa 1 dòng" });
});

app.get('/api/search', (req, res) => {
    const keyword = (req.query.q || '').toLowerCase().trim();
    if (!keyword) return res.json([]);
    
    const results = Object.values(masterDictionary).filter(p => 
        p.barcode.toLowerCase().includes(keyword) || p.tenSp.toLowerCase().includes(keyword)
    ).slice(0, 20); 
    res.json(results);
});

app.post('/api/resolve', (req, res) => {
    const { errorId, correctBarcode } = req.body;
    const errorIndex = printQueue.error.findIndex(e => e.id === errorId);
    if (errorIndex === -1) return res.status(404).json({ message: "Không thấy mã lỗi" });

    const correctProduct = masterDictionary[correctBarcode];
    if (!correctProduct) return res.status(404).json({ message: "Mã thay thế sai" });

    printQueue.error.splice(errorIndex, 1);
    printQueue.matched.push({ id: Date.now(), ...correctProduct });
    res.json({ message: "Đã sửa thành công" });
});

app.listen(PORT, () => console.log(`🚀 Server In Tag v3.0 đang chạy tại Port ${PORT}`));