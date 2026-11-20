import runpy
import sys

sys.path.insert(0, "/opt/quick-ppt")
runpy.run_module("app.presentations.quick_renderer", run_name="__main__")
