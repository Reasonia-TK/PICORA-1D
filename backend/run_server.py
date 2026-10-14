"""Run the PICORA-1D loopback backend."""
import argparse
import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8321)
    args = parser.parse_args()
    uvicorn.run("es_sim.server:app", host="127.0.0.1", port=args.port)
