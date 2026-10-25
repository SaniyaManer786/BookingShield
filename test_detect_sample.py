from backend.main import app
from fastapi.testclient import TestClient
c = TestClient(app)
r = c.get('/api/sample-frame')
print(r.status_code)
data = r.json()
if data.get('success'):
    img_b64 = data['image']
    payload = {'image': img_b64, 'track': False}
    res = c.post('/api/detect', json=payload)
    print(res.status_code)
    print(res.json())
else:
    print('no sample')
