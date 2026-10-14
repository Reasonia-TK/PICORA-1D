"""配布バックエンドの入口。loopback限定で起動する。"""
import argparse
import multiprocessing

import uvicorn
from es_sim.server import app


if __name__ == "__main__":
    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser(description="PICORA-1D backend")
    parser.add_argument("--port", type=int, default=8321)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be in 1..65535")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")
