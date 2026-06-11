from pathlib import Path
import sys
import traceback


ROOT = Path(__file__).resolve().parent
LOG = ROOT / "data" / "server.err.log"

try:
    sys.path.insert(0, str(ROOT / "app"))
    import app

    app.main()
except Exception:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    LOG.write_text(traceback.format_exc(), encoding="utf-8")
    raise
