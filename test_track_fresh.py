from backend.main import app, yolo_model, load_model
from fastapi.testclient import TestClient

# Reset model state like a fresh start
# Actually in same process model might be loaded
c = TestClient(app)
r = c.get('/api/sample-frame')
data = r.json()
payload = {'image': data['image'], 'track': True, 'bus_id': 'MH-12-QW-4821'}
try:
    res = c.post('/api/detect', json=payload)
    print(res.status_code)
    print(res.text[:120])
except Exception as e:
    import traceback
    traceback.print_exc()
