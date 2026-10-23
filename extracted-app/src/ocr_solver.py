#!/usr/bin/env python3
"""
ocr_solver.py — ThunderBolt stub Launcher OCR engine.

Usage:
    python ocr_solver.py <image_dir> [--target <target>] [--jobid <jobId>] [--method ddddocr|tesseract|auto]

Reads all image files in <image_dir>, OCRs each tile to read the NUMBER printed
on it, compares to --target, and prints ONE JSON line on stdout:
    {"result":[{"number":"153"},...], "target":"153", "jobId":"...", "method":"...", "error":null}

Captcha: BLS shows a 3x3 grid of 150x80 JPEG tiles, each a distorted multi-digit
number. The prompt (.box-label) shows the target number. The Launcher must OCR
each tile and return which tiles match the target.

content.js EXECUTE_OCR handler does (DECODED — see references/08):
  result.forEach((item,i)=>{ if(!item.number||!target.includes(item.number)) return;
                              tiles[i]?.querySelector("img")?.click(); })
So result MUST be a 9-element Array (one per tile, IN INDEX ORDER) so i aligns to
tiles[i]. Matching tiles get {number:target}; non-matching get {number:"-"} (sentinel
not a substring of digits-only target, avoids JS-substring trap like "45" in "475").
On OCR failure: result={error:"..."} -> content.js retry path.
"""
import argparse, json, os, sys, glob, re, io

def load_images(d):
    files = []
    for ext in ("*.jpg","*.jpeg","*.png","*.gif","*.bmp","*.bin"):
        files.extend(glob.glob(os.path.join(d, ext)))
    def idx(fp):
        b = os.path.basename(fp)
        try: return int(b.split('.')[0])
        except ValueError: return 9999
    files.sort(key=idx)
    return files

# ---- ddddocr engine ----
def get_ddddocr():
    import ddddocr
    try:
        return ddddocr.DdddOcr(ocr=True, show_ad=False)
    except TypeError:
        return ddddocr.DdddOcr(show_ad=False)

def preprocess(data):
    """Upscale 2x, grayscale, auto-threshold to boost ddddocr accuracy on noisy tiles."""
    try:
        from PIL import Image, ImageOps
        im = Image.open(io.BytesIO(data))
        im = im.convert("L")
        # upscale 2x for clearer strokes
        w, h = im.size
        im = im.resize((w*2, h*2))
        # auto-contrast / threshold: split at mid -> black digits on white
        im = ImageOps.autocontrast(im)
        buf = io.BytesIO()
        im.save(buf, format="JPEG")
        return buf.getvalue()
    except Exception:
        return None

def ocr_tile(ocr, data):
    """Try raw bytes first; if empty/mostly-non-digit, try preprocessed."""
    candidates = [data]
    pp = preprocess(data)
    if pp:
        candidates.append(pp)
    best = ""
    for d in candidates:
        try:
            t = ocr.classification(d)
        except Exception:
            t = ""
        t = t or ""
        digits = re.sub(r"\D+", "", t)
        # prefer the candidate yielding the longest digit run (most confident)
        if len(digits) > len(re.sub(r"\D+","",best)):
            best = t
    return best

def solve_ddddocr(files):
    ocr = get_ddddocr()
    results = []
    for fp in files:
        with open(fp, "rb") as f:
            data = f.read()
        try:
            text = ocr_tile(ocr, data)
        except Exception as e:
            text = ""
            print(f"[ocr] {os.path.basename(fp)} err: {e}", file=sys.stderr)
        num = re.sub(r"\D+", "", text or "")
        results.append({"file": os.path.basename(fp), "raw": text, "number": num})
        print(f"[ocr] {os.path.basename(fp)} raw={text!r} number={num!r}", file=sys.stderr)
    return results, "ddddocr"

def solve_tesseract(files):
    import pytesseract
    from PIL import Image, ImageOps
    results = []
    for fp in files:
        try:
            im = Image.open(fp).convert("L")
            w,h = im.size; im = im.resize((w*2,h*2))
            im = ImageOps.autocontrast(im)
            text = pytesseract.image_to_string(im, config="--psm 7 -c tessedit_char_whitelist=0123456789").strip()
        except Exception as e:
            text = ""
            print(f"[ocr] {os.path.basename(fp)} err: {e}", file=sys.stderr)
        num = re.sub(r"\D+", "", text or "")
        results.append({"file": os.path.basename(fp), "raw": text, "number": num})
        print(f"[ocr] {os.path.basename(fp)} raw={text!r} number={num!r}", file=sys.stderr)
    return results, "tesseract"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image_dir")
    ap.add_argument("--target", default="")
    ap.add_argument("--jobid", default="")
    ap.add_argument("--method", default="auto", choices=["auto","ddddocr","tesseract"])
    args = ap.parse_args()

    if not os.path.isdir(args.image_dir):
        json.dump({"result":{"error":"no image dir"},"target":args.target,"jobId":args.jobid,"method":"none"}, sys.stdout); print(); return
    files = load_images(args.image_dir)
    if not files:
        json.dump({"result":{"error":"no images"},"target":args.target,"jobId":args.jobid,"method":"none"}, sys.stdout); print(); return

    results, method, error = [], "none", None
    for m in (args.method,) if args.method != "auto" else ("ddddocr","tesseract"):
        try:
            if m == "ddddocr": results, method = solve_ddddocr(files)
            elif m == "tesseract": results, method = solve_tesseract(files)
            if results: break
        except ImportError as e:
            print(f"[ocr] {m} not available: {e}", file=sys.stderr); continue
        except Exception as e:
            error = f"{m}: {e}"; print(f"[ocr] {m} failed: {e}", file=sys.stderr); continue

    if not results:
        # ddddocr/tesseract not installed or crashed — surface a clear error
        json.dump({"result":{"error":"OCR engine unavailable ("+(error or 'ddddocr not installed')+")"}, "target":args.target,"jobId":args.jobid,"method":method,"error":error}, sys.stdout); print(); return

    target = str(args.target or "")
    # Build 9-element aligned result array (one per tile, in order).
    # Matching tile -> {number: target}; non-matching -> {number: "-"} (sentinel).
    all_items = []
    matched_count = 0
    for r in results:
        num = r.get("number", "")
        if target and num == target:
            all_items.append({"number": target})
            matched_count += 1
        elif target and num and len(num) == len(target) and num in target and target in num:
            # tolerate exact-length near-match (rare); treat as match
            all_items.append({"number": target})
            matched_count += 1
        else:
            all_items.append({"number": "-"})
    if target and matched_count == 0:
        out = {"result":{"error":f"no tile matched target {target!r} (ocr reads: {[r['raw'] for r in results]})"},"target":target,"jobId":args.jobid,"method":method,"error":error}
    else:
        out = {"result":all_items,"target":target,"jobId":args.jobid,"method":method,"error":error}
    json.dump(out, sys.stdout); print()
    sys.stderr.write(f"[ocr] DONE matched={matched_count} target={target!r} method={method}\n")

if __name__ == "__main__":
    main()
