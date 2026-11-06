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
if not args or args[0] != "rest":
    sys.exit(3)
method = args[args.index("--method") + 1]
url = args[args.index("--url") + 1].split("?")[0]
query = args[args.index("--query") + 1] if "--query" in args else None
properties = {"image": "previous-image", "isMain": True, "startUpCommand": "preserve-startup",
              "environmentVariables": [{"name": "SYNTHETIC", "value": "private-placeholder"}]}
if os.environ.get("FAIL_READ") and method == "get":
    print("private-cloud-identifier", file=sys.stderr)
    sys.exit(2)
if method == "get" and "/serverfarms/" in url:
    print(os.environ.get("WORKERS", "1"))
elif method == "get" and url.endswith("/slots"):
    print(os.environ.get("SLOTS", "0"))
elif method == "get" and url.endswith("/sitecontainers/main"):
    print(json.dumps({"properties": properties}))
elif method == "get":
    print({"properties.serverFarmId": "/subscriptions/synthetic/providers/Microsoft.Web/serverfarms/synthetic-plan",
           "properties.defaultHostName": "synthetic.invalid",
           "properties.state": state.read_text() if state.exists() else "Running"}[query])
elif method == "post" and url.endswith("/stop"):
    state.write_text("Stopped")
elif method == "put" and url.endswith("/sitecontainers/main"):
    body_argument = args[args.index("--body") + 1]
    assert body_argument.startswith("@")
    body = json.loads(pathlib.Path(body_argument[1:]).read_text())
    properties["image"] = os.environ["IMAGE"]
    assert body == {"properties": properties}, "Only the image may change"
    sys.exit(2 if os.environ.get("FAIL_UPDATE") else 0)
elif method == "post" and url.endswith("/start"):
    state.write_text("Running")
else:
    sys.exit(3)
""")
            curl = root / "curl"
            curl.write_text("""#!/usr/bin/env python3
import os, sys
if os.environ.get("FAIL_HEALTH"):
    sys.exit(22)
print('{"status":"ok"}')
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
                "AZURE_SUBSCRIPTION_ID": "synthetic",
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
        stop = next(i for i, call in enumerate(calls) if "/stop?" in call[call.index("--url") + 1])
        update = next(i for i, call in enumerate(calls) if "put" == call[call.index("--method") + 1])
        start = next(i for i, call in enumerate(calls) if "/start?" in call[call.index("--url") + 1])
        self.assertLess(stop, update)
        self.assertLess(update, start)
        self.assertEqual(state, "Running")
        self.assertNotIn("private-placeholder", json.dumps(calls))

    def test_failed_read_does_not_expose_cloud_diagnostics_or_mutate(self):
        result, calls, state = self.run_deployment(FAIL_READ="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(state)
        self.assertNotIn("private-cloud-identifier", result.stdout + result.stderr)
        self.assertTrue(all(call[call.index("--method") + 1] == "get" for call in calls))

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
            self.assertTrue(all(call[call.index("--method") + 1] == "get" for call in calls))
