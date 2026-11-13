const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const multer = require('multer');
const { execFile } = require('child_process');

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

    const files = fs.readdirSync(DATA_DIR)
        .filter(f => f.toLowerCase().endsWith(".xlsx"));

    console.log("Đang đọc:", files);

    files.forEach(file => {

        try {

            const workbook = xlsx.readFile(path.join(DATA_DIR, file));

            const sheet = workbook.Sheets[workbook.SheetNames[0]];

            const rawData = xlsx.utils.sheet_to_json(sheet, {
                header: 1,
                raw: false,
                defval: ""
            });

            let headerRow = -1;
            let headers = [];

            for (let i = 0; i < rawData.length; i++) {

                const row = rawData[i].map(x =>
                    String(x).trim().toUpperCase()
                );

                if (
                    row.includes("BARCODE") ||
                    row.includes("PRODUCT CODE")
                ) {

                    headerRow = i;
                    headers = row;
                    break;
                }
            }

            if (headerRow === -1) {
                console.log(file, "không tìm thấy header");
                return;
            }

            let count = 0;

            for (let i = headerRow + 1; i < rawData.length; i++) {

                const row = rawData[i];

                if (!row.length) continue;

                let obj = {};

                headers.forEach((h, index) => {
                    obj[h] = row[index];
                });

                const barcode = String(
                    obj["BARCODE"] ||
                    obj["PRODUCT CODE"] ||
                    ""
                ).trim();

                if (!barcode) continue;

                masterDictionary[barcode] = {

                    barcode,

                    tenSp: String(
                        obj["PRODUCT DESCRIPTION"] ||
                        obj["NAME PRODUCT"] ||
                        obj["TEN_SP FINAL"] ||
                        ""
                    ).trim(),

                    ticket: String(
                        obj["UNIT TICKET VALUE"] ||
                        obj["TICKET"] ||
                        ""
                    ).trim()
                };

                count++;
            }

            console.log(`${file}: ${count} sản phẩm`);

        }
        catch (e) {
            console.log(e);
        }

    });

    console.log("Tổng:", Object.keys(masterDictionary).length);

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

const errorStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'public', 'uploads', 'errors');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, 'err-' + Date.now() + '.jpg')
});
const uploadError = multer({ storage: errorStorage });

// --- Màn hình Trạm 1 (Scan Camera trên điện thoại) ---
app.get('/scan', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'scan.html'));
});

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

// --- Module gọi OpenCV Python để giải mã ảnh ca khó ---
function runOpenCVScan(imageFullPath) {
    return new Promise((resolve) => {
        if (!fs.existsSync(imageFullPath)) {
            return resolve({ success: false, message: "File ảnh không tồn tại" });
        }
        const scriptPath = path.join(__dirname, 'ai_scanner.py');
        execFile('python3', [scriptPath, imageFullPath], { timeout: 10000 }, (error, stdout, stderr) => {
            if (error) {
                console.log("OpenCV execution note:", error.message);
                return resolve({ success: false, message: error.message });
            }
            try {
                const parsed = JSON.parse(stdout.trim());
                resolve(parsed);
            } catch (e) {
                resolve({ success: false, message: "Lỗi đọc kết quả OpenCV" });
            }
        });
    });
}

// --- Nhận ảnh báo lỗi từ Trạm 1 & Tự động chạy OpenCV nhận diện ngay ---
app.post('/api/report-error', uploadError.single('image'), async (req, res) => {
    const imageUrl = req.file ? `/uploads/errors/${req.file.filename}` : '';
    const note = (req.body.note || '').trim();
    const fullPath = req.file ? req.file.path : null;

    let aiResult = { success: false };
    if (fullPath) {
        // Chạy OpenCV quét thử ảnh vừa nhận
        aiResult = await runOpenCVScan(fullPath);
    }

    if (aiResult.success && aiResult.barcode) {
        const detectedBarcode = aiResult.barcode.trim();
        const foundProduct = masterDictionary[detectedBarcode];

        if (foundProduct) {
            // Tự động giải cứu thành công! Chuyển thẳng sang hàng in Chờ In
            const matchedItem = {
                id: Date.now(),
                ...foundProduct,
                aiRecognized: true,
                method: aiResult.method || 'OpenCV',
                imageUrl: imageUrl
            };
            printQueue.matched.push(matchedItem);
            return res.json({
                success: true,
                aiResolved: true,
                barcode: detectedBarcode,
                message: `🤖 OpenCV đã tự nhận diện thành công mã: ${detectedBarcode} (${foundProduct.tenSp})! Đã chuyển sang hàng in.`,
                item: matchedItem
            });
        } else {
            // Đọc được mã nhưng chưa có trong Excel -> lưu mã thật vào hàng đợi lỗi
            const errorItem = {
                id: Date.now(),
                barcode: detectedBarcode,
                imageUrl: imageUrl,
                suggestedName: `OpenCV đọc được mã ${detectedBarcode} (Chưa có trong Excel)`,
                time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                aiScanned: true
            };
            printQueue.error.unshift(errorItem);
            return res.json({
                success: true,
                aiResolved: false,
                barcode: detectedBarcode,
                message: `🤖 OpenCV đọc được mã: ${detectedBarcode} nhưng chưa có trong danh mục Excel!`,
                item: errorItem
            });
        }
    }

    // Nếu ảnh quá nát hoặc chưa đọc được -> đưa vào hàng đợi lỗi để quản lý xử lý
    const errorItem = {
        id: Date.now(),
        barcode: req.body.barcode || '⚠️ Không đọc được (Có ảnh)',
        imageUrl: imageUrl,
        suggestedName: note,
        time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        aiScanned: true
    };
    printQueue.error.unshift(errorItem);
    res.json({ success: true, aiResolved: false, message: "Đã lưu ảnh vào hàng đợi lỗi để quản lý đối soát!", item: errorItem });
});

// --- API quét lại toàn bộ hàng đợi lỗi bằng OpenCV ---
app.post('/api/ai-scan-all', async (req, res) => {
    if (printQueue.error.length === 0) {
        return res.json({ success: true, count: 0, message: "Hàng đợi lỗi đang trống!" });
    }

    let successCount = 0;
    const remainingErrors = [];

    for (const err of printQueue.error) {
        if (!err.imageUrl) {
            remainingErrors.push(err);
            continue;
        }

        const localPath = path.join(__dirname, 'public', err.imageUrl);
        const aiResult = await runOpenCVScan(localPath);

        if (aiResult.success && aiResult.barcode) {
            const detectedCode = aiResult.barcode.trim();
            const foundProduct = masterDictionary[detectedCode];

            if (foundProduct) {
                printQueue.matched.push({
                    id: Date.now() + Math.floor(Math.random() * 1000),
                    ...foundProduct,
                    aiRecognized: true,
                    method: aiResult.method || 'OpenCV Batch',
                    imageUrl: err.imageUrl
                });
                successCount++;
            } else {
                err.barcode = detectedCode;
                err.suggestedName = `OpenCV đọc được ${detectedCode} (Chưa có trong Excel)`;
                remainingErrors.push(err);
            }
        } else {
            remainingErrors.push(err);
        }
    }

    printQueue.error = remainingErrors;
    res.json({
        success: true,
        resolvedCount: successCount,
        remainingCount: remainingErrors.length,
        message: `🤖 OpenCV đã tự động giải cứu thành công ${successCount} mã lỗi!`
    });
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