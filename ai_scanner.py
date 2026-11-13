#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI Barcode Scanner using OpenCV
Tiền xử lý ảnh chuyên sâu cho các ca khó (nhòe quang học iPhone, bóng lóa nilông, vạch mờ, xoay nghiêng)
"""

import sys
import json
import os

def scan_with_opencv(image_path):
    import cv2
    import numpy as np

    if not os.path.exists(image_path):
        return {"success": False, "message": "File ảnh không tồn tại"}

    img = cv2.imread(image_path)
    if img is None:
        return {"success": False, "message": "Không thể đọc file ảnh"}

    # Khởi tạo detector của OpenCV
    barcode_detector = None
    if hasattr(cv2, 'barcode') and hasattr(cv2.barcode, 'BarcodeDetector'):
        try:
            barcode_detector = cv2.barcode.BarcodeDetector()
        except Exception:
            barcode_detector = None

    qr_detector = cv2.QRCodeDetector()

    def try_detect(mat):
        # 1. Thử nhận diện bằng OpenCV BarcodeDetector (EAN-13, Code 128, Code 39, UPC...)
        if barcode_detector is not None:
            try:
                ret, decoded_info, decoded_type, _ = barcode_detector.detectAndDecode(mat)
                if ret and decoded_info:
                    code = decoded_info[0] if isinstance(decoded_info, (list, tuple)) else decoded_info
                    if code and len(code.strip()) > 0:
                        return code.strip()
            except Exception:
                pass

        # 2. Thử QR Detector
        try:
            val, pts, _ = qr_detector.detectAndDecode(mat)
            if val and len(val.strip()) > 0:
                return val.strip()
        except Exception:
            pass

        # 3. Thử qua pyzbar nếu có cài đặt
        try:
            from pyzbar.pyzbar import decode
            barcodes = decode(mat)
            if barcodes:
                return barcodes[0].data.decode("utf-8").strip()
        except Exception:
            pass

        return None

    # Danh sách các góc xoay cần thử (nhân viên có thể chụp ngang / dọc / nghiêng)
    angles = [0, 90, 180, 270]

    for angle in angles:
        if angle == 0:
            rotated = img
        elif angle == 90:
            rotated = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        elif angle == 180:
            rotated = cv2.rotate(img, cv2.ROTATE_180)
        elif angle == 270:
            rotated = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)

        # Pipeline 1: Thử trực tiếp ảnh gốc
        res = try_detect(rotated)
        if res:
            return {"success": True, "barcode": res, "method": f"Direct (Angle {angle}°)"}

        # Chuyển sang ảnh xám
        gray = cv2.cvtColor(rotated, cv2.COLOR_BGR2GRAY)

        # Pipeline 2: Cân bằng tương phản cục bộ (CLAHE) - Khắc phục bóng lóa nilông / ngược sáng
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        res = try_detect(enhanced)
        if res:
            return {"success": True, "barcode": res, "method": f"OpenCV CLAHE (Angle {angle}°)"}

        # Pipeline 3: Làm sắc nét viền (Unsharp Masking) - Cứu ảnh nhòe do iPhone out-focus
        gaussian = cv2.GaussianBlur(gray, (0, 0), 2.0)
        unsharp = cv2.addWeighted(gray, 1.8, gaussian, -0.8, 0)
        res = try_detect(unsharp)
        if res:
            return {"success": True, "barcode": res, "method": f"OpenCV Unsharp Mask (Angle {angle}°)"}

        # Pipeline 4: Nhị phân hóa Otsu
        _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        res = try_detect(otsu)
        if res:
            return {"success": True, "barcode": res, "method": f"OpenCV Otsu (Angle {angle}°)"}

        # Pipeline 5: Morphological Closing để hàn gắn các sọc mã vạch bị đứt nét
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        closed = cv2.morphologyEx(otsu, cv2.MORPH_CLOSE, kernel)
        res = try_detect(closed)
        if res:
            return {"success": True, "barcode": res, "method": f"OpenCV Morph Close (Angle {angle}°)"}

    return {"success": False, "message": "Không nhận diện được mã vạch trong ảnh"}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "message": "Thiếu tham số đường dẫn ảnh"}))
        sys.exit(1)

    image_path = sys.argv[1]

    # Kiểm tra xem có thư viện cv2 không
    try:
        import cv2
        result = scan_with_opencv(image_path)
    except ImportError:
        # Fallback nếu môi trường chưa cài cv2
        result = {
            "success": False,
            "message": "Môi trường máy chủ chưa nạp opencv-python (Cần apk add py3-opencv)"
        }

    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
