import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


@unittest.skipIf(os.name == "nt", "Bash operational script is exercised on hosted Linux")
class DeploymentTests(unittest.TestCase):
    def run_deployment(self, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            az = root / "az"
            az.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
state = pathlib.Path(os.environ["STATE_FILE"])
if args[:3] == ["appservice", "plan", "show"]:
    print(os.environ.get("WORKERS", "1"))
elif args[:4] == ["webapp", "deployment", "slot", "list"]:
    print(os.environ.get("SLOTS", "0"))
elif args[:2] == ["webapp", "show"]:
    query = args[args.index("--query") + 1]
    print({"serverFarmId": "synthetic-plan", "defaultHostName": "synthetic.invalid",
           "state": state.read_text() if state.exists() else "Running"}[query])
elif args[:2] == ["webapp", "stop"]:
    state.write_text("Stopped")
elif args[:3] == ["webapp", "sitecontainers", "update"]:
    sys.exit(2 if os.environ.get("FAIL_UPDATE") else 0)
elif args[:2] == ["webapp", "start"]:
    state.write_text("Running")
else:
    sys.exit(3)
""")
            curl = root / "curl"
            curl.write_text("""#!/usr/bin/env python3
import os, sys
if os.environ.get("FAIL_HEALTH"):
    sys.exit(22)
print('{"runningSetup":false,"needSetup":false}')
""")
            sleep = root / "sleep"
            sleep.write_text("#!/bin/sh\nexit 0\n")
            for file in (az, curl, sleep):
                file.chmod(0o755)
            environment = {
                **os.environ,
                "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "CALL_LOG": str(root / "calls"),
                "STATE_FILE": str(root / "state"),
                "DEPLOYMENT_APPROVED": "true", "BACKUPS_VERIFIED": "true",
                "AZURE_RESOURCE_GROUP": "synthetic", "AZURE_WEBAPP_NAME": "synthetic",
                "IMAGE": "ghcr.io/fletchto99/uptime-kuma-azure@sha256:" + "a" * 64,
                **overrides,
            }
            result = subprocess.run(["bash", "scripts/deploy.sh"], env=environment,
                                    capture_output=True, text=True, timeout=30)
            calls = [json.loads(line) for line in (root / "calls").read_text().splitlines()] if (root / "calls").exists() else []
            state = (root / "state").read_text() if (root / "state").exists() else None
            return result, calls, state

    def test_stop_update_start_order(self):
        result, calls, state = self.run_deployment()
        self.assertEqual(result.returncode, 0, result.stderr)
        stop = next(i for i, call in enumerate(calls) if call[:2] == ["webapp", "stop"])
        update = next(i for i, call in enumerate(calls) if call[:3] == ["webapp", "sitecontainers", "update"])
        start = next(i for i, call in enumerate(calls) if call[:2] == ["webapp", "start"])
        self.assertLess(stop, update)
        self.assertLess(update, start)
        self.assertEqual(state, "Running")

    def test_failures_leave_app_stopped(self):
        for failure in ("FAIL_UPDATE", "FAIL_HEALTH"):
            result, _, state = self.run_deployment(**{failure: "1"})
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(state, "Stopped")

    def test_unapproved_or_duplicate_workers_refused(self):
        for override in ({"DEPLOYMENT_APPROVED": "false"}, {"BACKUPS_VERIFIED": "false"},
                         {"WORKERS": "2"}, {"SLOTS": "1"}, {"IMAGE": "untrusted:latest"}):
            result, calls, _ = self.run_deployment(**override)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(any(call[:2] in (["webapp", "stop"], ["webapp", "start"]) for call in calls))
