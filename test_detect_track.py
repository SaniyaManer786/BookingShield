from backend.main import app
from fastapi.testclient import TestClient
from backend.main import reset_tracker

c = TestClient(app)
from backend import main
# ensure model loaded
if main.yolo_model is None:
    main.load_model()

from backend.main import get_sample_frame
# get sample
r = c.get('/api/sample-frame')
data = r.json()
payload = {'image': data['image'], 'track': True, 'bus_id': 'MH-12-QW-4821'}
try:
    res = c.post('/api/detect', json=payload)
    print(res.status_code)
    print(res.text[:80])
    # send again
    res = c.post('/api/detect', json=payload)
    print(res.status_code)
    print(res.text[:80])
except Exception as e:
    import traceback
    traceback.print_exc()
