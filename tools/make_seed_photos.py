"""Generate geotagged sample result-sheet photos for seeding the portal.

piexif is not installed, so the EXIF APP1 segment carrying the GPS IFD is
built by hand and spliced in after the JPEG's SOI marker. Only the four GPS
tags the API actually reads are written.
"""
import struct
from PIL import Image, ImageDraw, ImageFont

FONT = "C:/Windows/Fonts/arialbd.ttf"


def gps_app1(lat, lon):
    """A minimal big-endian ('MM') EXIF block holding just latitude/longitude."""
    lat_ref = b"N" if lat >= 0 else b"S"
    lon_ref = b"E" if lon >= 0 else b"W"
    lat, lon = abs(lat), abs(lon)

    def dms(v):
        d = int(v)
        m = int((v - d) * 60)
        s = round((v - d - m / 60) * 3600 * 100)
        return struct.pack(">6I", d, 1, m, 1, s, 100)

    # Offsets are measured from the start of the TIFF header.
    # 0..7 header | 8..25 IFD0 | 26..79 GPS IFD | 80.. rational payloads
    lat_off, lon_off = 80, 104

    tiff = b"MM" + struct.pack(">HI", 42, 8)
    ifd0 = struct.pack(">H", 1) + struct.pack(">HHII", 0x8825, 4, 1, 26) + struct.pack(">I", 0)
    gps = (
        struct.pack(">H", 4)
        + struct.pack(">HHI", 1, 2, 2) + lat_ref + b"\x00\x00\x00"
        + struct.pack(">HHII", 2, 5, 3, lat_off)
        + struct.pack(">HHI", 3, 2, 2) + lon_ref + b"\x00\x00\x00"
        + struct.pack(">HHII", 4, 5, 3, lon_off)
        + struct.pack(">I", 0)
    )
    payload = b"Exif\x00\x00" + tiff + ifd0 + gps + dms(lat) + dms(lon)
    return b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload


def sheet(path, pu_code, pu_name, results, lat, lon, variant=0):
    W, H = 1000, 1350
    img = Image.new("RGB", (W, H), (247, 246, 240))
    d = ImageDraw.Draw(img)
    big = ImageFont.truetype(FONT, 40)
    mid = ImageFont.truetype(FONT, 34)
    small = ImageFont.truetype(FONT, 26)

    # A slight tint difference between the two "phones" so the seeded photos
    # are visibly distinct even though the figures match.
    if variant:
        d.rectangle([0, 0, W, H], fill=(243, 245, 248))

    y = 50
    d.text((60, y), "INEC — POLLING UNIT RESULT", font=big, fill=(15, 15, 15)); y += 60
    d.text((60, y), "FORM EC8A", font=mid, fill=(60, 60, 60)); y += 55
    d.text((60, y), f"PU CODE: {pu_code}", font=small, fill=(20, 20, 20)); y += 38
    d.text((60, y), f"PU NAME: {pu_name[:38]}", font=small, fill=(20, 20, 20)); y += 38
    d.text((60, y), "STATE: OSUN", font=small, fill=(20, 20, 20)); y += 50

    d.line([60, y, W - 60, y], fill=(30, 30, 30), width=3); y += 26
    d.text((60, y), "PARTY", font=mid, fill=(0, 0, 0))
    d.text((640, y), "VOTES", font=mid, fill=(0, 0, 0)); y += 50
    d.line([60, y, W - 60, y], fill=(30, 30, 30), width=2); y += 24

    for party, votes in results.items():
        d.text((60, y), party, font=mid, fill=(10, 10, 10))
        d.text((640, y), str(votes), font=mid, fill=(10, 10, 10))
        y += 56

    y += 20
    d.line([60, y, W - 60, y], fill=(30, 30, 30), width=2); y += 30
    total = sum(results.values())
    d.text((60, y), "TOTAL VALID VOTES", font=mid, fill=(0, 0, 0))
    d.text((640, y), str(total), font=mid, fill=(0, 0, 0))

    img.save(path, "JPEG", quality=88)

    # Splice the GPS block in immediately after SOI.
    raw = open(path, "rb").read()
    open(path, "wb").write(raw[:2] + gps_app1(lat, lon) + raw[2:])


if __name__ == "__main__":
    import os, json
    os.makedirs("tools/seed", exist_ok=True)
    plan = [
        ("29-01-01-001", "TOWN HALL IWARA", {"APC": 212, "PDP": 178, "LP": 64, "NNPP": 21, "ADC": 9}, 7.5512, 4.7231),
        ("29-01-01-002", "UNITY PRY. SCHOOL, IWARA", {"APC": 143, "PDP": 205, "LP": 88, "NNPP": 17, "ADC": 6}, 7.5548, 4.7290),
    ]
    manifest = []
    for code, name, res, lat, lon in plan:
        for v in (0, 1):
            p = f"tools/seed/{code}-{v + 1}.jpg"
            sheet(p, code, name, res, lat, lon, variant=v)
            manifest.append({"puCode": code, "file": p, "device": f"seed-phone-{v + 1}", "expect": res})
            print("wrote", p, os.path.getsize(p), "bytes")
    json.dump(manifest, open("tools/seed/manifest.json", "w"), indent=2)
