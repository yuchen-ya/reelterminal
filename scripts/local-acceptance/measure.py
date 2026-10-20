"""Run one acceptance command and sample its process tree; no shared-env edits."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

import psutil


parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
parser.add_argument("--timeout", type=float, default=600)
parser.add_argument("command", nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ["--"] else args.command
output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
dirty = subprocess.check_output(["git", "status", "--porcelain"], text=True).strip()
started = time.monotonic()
samples = []
owned = {}
timed_out = False
with output.with_suffix(".log").open("w", encoding="utf-8") as log:
    child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    root = psutil.Process(child.pid)
    while child.poll() is None:
        processes = [root]
        try:
            processes += root.children(recursive=True)
        except psutil.NoSuchProcess:
            pass
        rss = cpu = read_bytes = write_bytes = 0
        for process in processes:
            try:
                owned[process.pid] = process
                rss += process.memory_info().rss
                times = process.cpu_times()
                cpu += times.user + times.system
                io = process.io_counters()
                read_bytes += io.read_bytes
                write_bytes += io.write_bytes
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        gpu = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        )
        samples.append({
            "elapsed_s": round(time.monotonic() - started, 3),
            "tree_rss_bytes": rss, "live_tree_cpu_seconds": cpu,
            "live_tree_read_bytes": read_bytes, "live_tree_write_bytes": write_bytes,
            "system_cpu_percent": psutil.cpu_percent(),
            "system_available_bytes": psutil.virtual_memory().available,
            "whole_gpu_memory_mib_util_percent": gpu.stdout.strip(),
        })
        if time.monotonic() - started > args.timeout:
            timed_out = True
            for process in reversed(list(owned.values())):
                try:
                    process.kill()
                except psutil.NoSuchProcess:
                    pass
            break
        time.sleep(0.75)
    returncode = child.wait()
time.sleep(1)
survivors = [
    {"pid": p.pid, "name": p.name()}
    for p in owned.values() if p.is_running()
]
result = {
    "source_sha": head, "dirty": bool(dirty), "status": dirty.splitlines(),
    "command": command, "returncode": returncode, "timed_out": timed_out,
    "wall_seconds": round(time.monotonic() - started, 3),
    "sampled_peak_tree_rss_mib": round(max((s["tree_rss_bytes"] for s in samples), default=0) / 1048576, 1),
    "survivors": survivors,
    "measurement_limits": "RSS sums shared pages; sampled peaks may miss spikes. GPU is whole-device including background apps. CPU/I/O counters include only currently live descendants, not cumulative exited children.",
    "samples": samples,
}
output.write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps({k: v for k, v in result.items() if k not in ("samples", "command", "status")}, indent=2))
raise SystemExit(returncode if not timed_out else 124)
