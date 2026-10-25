from backend.main import app
from fastapi.testclient import TestClient
c = TestClient(app)
r = c.get('/api/sample-frame')
data = r.json()
if data.get('success'):
    img_b64 = data['image']
    payload = {'image': img_b64, 'track': True, 'bus_id': 'MH-12-QW-4821'}
    res = c.post('/api/detect', json=payload)
    print(res.status_code)
    print(res.json())
