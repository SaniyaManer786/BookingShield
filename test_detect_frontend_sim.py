from backend.main import app
from fastapi.testclient import TestClient
import base64
import numpy as np
import cv2
from io import BytesIO
from PIL import Image

c = TestClient(app)
# Simulate frontend: create canvas-like image, convert to JPEG at quality 0.8 as dataURL
img = np.zeros((720, 1280, 3), dtype=np.uint8)
# Add some random noise/colors to simulate real camera
img[:] = (100, 120, 140)
cv2.rectangle(img, (400, 200), (600, 500), (150, 150, 150), -1)
# Convert to JPEG like canvas
img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
pil_img = Image.fromarray(img_rgb)
buffer = BytesIO()
pil_img.save(buffer, format='JPEG', quality=80)
b64 = 'data:image/jpeg;base64,' + base64.b64encode(buffer.getvalue()).decode('utf-8')

payload = {'image': b64, 'track': True, 'bus_id': 'MH-12-QW-4821'}
try:
    res = c.post('/api/detect', json=payload)
    print(res.status_code)
    print(res.text[:100])
except Exception as e:
    import traceback
    traceback.print_exc()
