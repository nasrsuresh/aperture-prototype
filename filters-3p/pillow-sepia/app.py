"""A third-party marketplace filter, as an external developer would ship it.

Honors the file-based contract from the submission (B Decision 2): the event
is {invocationId, contractVersion, input: {url,...}, output: {url,...},
params, deadline}; the filter GETs the input URL, writes the output URL, and
returns {status, output?, error?, metrics?}. It has no AWS permissions beyond
logging and runs in a VPC with no internet route.

FILTER_MODE selects behaviour for the experiments:
  sepia    normal filter
  hostile  also probes the boundary (internet, S3 ListBucket, DynamoDB) and
           reports what happened in metrics.probes
  liar     returns status ok without writing any output (E11)
"""
import io
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from PIL import Image

MODE = os.environ.get("FILTER_MODE", "sepia")
PROBE_TIMEOUT = 3


def handler(event, context):
    t0 = time.time()
    metrics = {"mode": MODE}
    try:
        if MODE == "hostile":
            metrics["probes"] = probe_boundary(event)

        data = http("GET", event["input"]["url"])
        img = Image.open(io.BytesIO(data)).convert("RGB")
        intensity = float((event.get("params") or {}).get("intensity", 1.0))
        out = sepia(img, intensity)
        buf = io.BytesIO()
        out.save(buf, format="JPEG", quality=90)
        payload = buf.getvalue()

        if MODE != "liar":
            http("PUT", event["output"]["url"], payload, event["output"]["contentType"])

        metrics["ms"] = int((time.time() - t0) * 1000)
        return {
            "status": "ok",
            "output": {"width": out.width, "height": out.height, "bytes": len(payload)},
            "metrics": metrics,
        }
    except Exception as e:  # the envelope, not an exception, carries errors
        metrics["ms"] = int((time.time() - t0) * 1000)
        return {
            "status": "error",
            "error": {"code": type(e).__name__, "message": str(e)[:500], "retryable": False},
            "metrics": metrics,
        }


def sepia(img, intensity):
    r, g, b = img.split()
    w, h = img.size
    src = img.load()
    out = Image.new("RGB", (w, h))
    dst = out.load()
    for y in range(h):
        for x in range(w):
            pr, pg, pb = src[x, y]
            tr = min(255, int(0.393 * pr + 0.769 * pg + 0.189 * pb))
            tg = min(255, int(0.349 * pr + 0.686 * pg + 0.168 * pb))
            tb = min(255, int(0.272 * pr + 0.534 * pg + 0.131 * pb))
            dst[x, y] = (
                int(pr + (tr - pr) * intensity),
                int(pg + (tg - pg) * intensity),
                int(pb + (tb - pb) * intensity),
            )
    return out


def http(method, url, body=None, content_type=None):
    req = urllib.request.Request(url, data=body, method=method)
    if content_type:
        req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read()


def probe_boundary(event):
    """What a hostile filter would try. Every probe is expected to fail."""
    probes = {}

    # 1. Call out to the internet.
    try:
        urllib.request.urlopen("https://example.com/", timeout=PROBE_TIMEOUT)
        probes["internet"] = "REACHED (boundary broken)"
    except Exception as e:
        probes["internet"] = f"blocked: {type(e).__name__}: {str(e)[:80]}"

    # 2. Use the function's own credentials against the bucket named in the
    #    input URL (the only thing it can learn about where it is running).
    bucket = urllib.parse.urlparse(event["input"]["url"]).hostname.split(".")[0]
    try:
        import boto3
        from botocore.config import Config

        cfg = Config(connect_timeout=PROBE_TIMEOUT, read_timeout=PROBE_TIMEOUT, retries={"max_attempts": 0})
        s3 = boto3.client("s3", config=cfg)
        s3.list_objects_v2(Bucket=bucket, MaxKeys=5)
        probes["listBucket"] = "LISTED (boundary broken)"
    except Exception as e:
        probes["listBucket"] = f"denied: {type(e).__name__}: {str(e)[:100]}"

    # 3. Reach another AWS service through the VPC.
    try:
        ddb = boto3.client("dynamodb", config=cfg)
        ddb.list_tables(Limit=5)
        probes["dynamodb"] = "LISTED (boundary broken)"
    except Exception as e:
        probes["dynamodb"] = f"denied: {type(e).__name__}: {str(e)[:100]}"

    # 4. A different bucket, via the S3 gateway endpoint policy.
    try:
        s3.head_bucket(Bucket="aws-cli")  # a well-known public bucket
        probes["otherBucket"] = "REACHED (boundary broken)"
    except Exception as e:
        probes["otherBucket"] = f"denied: {type(e).__name__}: {str(e)[:100]}"

    return probes
