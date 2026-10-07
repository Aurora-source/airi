"""Run existing Mura TTS commands for a test, then stop only owned processes."""
import argparse
import importlib.util
import os
import subprocess
import sys
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ops-config", required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("mura_test_config", args.ops_config)
    config = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(config)
    processes = []
    try:
        with urllib.request.urlopen("http://127.0.0.1:11996/v1/models", timeout=1) as response:
            if response.status == 200:
                print("An existing Mura service is ready; no test process was started.", flush=True)
                return
    except OSError:
        pass
    try:
        for service in ("crispasr", "tts-proxy"):
            command, cwd, env, required = config.command(service)
            if not all(path.exists() for path in required):
                raise RuntimeError(f"Missing {service} service files")
            processes.append(subprocess.Popen(
                ["rtk", "proxy", *command], cwd=cwd, env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            ))
        for _ in range(60):
            if any(process.poll() is not None for process in processes):
                raise RuntimeError("A Mura service exited before readiness")
            try:
                with urllib.request.urlopen("http://127.0.0.1:11996/v1/models", timeout=1) as response:
                    if response.status == 200:
                        print("Mura test host ready at 127.0.0.1:11996. Send stop to finish.", flush=True)
                        break
            except OSError:
                time.sleep(1)
        else:
            raise RuntimeError("Mura test host readiness timeout")
        for line in sys.stdin:
            if line.strip() == "stop":
                break
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                # Terminate this owned process tree, including RTK's child.
                if os.name == "nt":
                    subprocess.run(["rtk", "proxy", "taskkill", "/PID", str(process.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    process.terminate()


if __name__ == "__main__":
    main()
