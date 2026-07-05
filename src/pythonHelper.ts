import { ChannelOrder } from './types';

const HELPER_CODE = String.raw`
import io
import json
import tempfile

__CVP_MAX_BATCH_ITEMS = 64
__CVP_MAX_TABLE_ROWS = 200

def __cvp_json_default(value):
    try:
        return value.item()
    except Exception:
        return str(value)

def __cvp_require_numpy():
    try:
        import numpy as np
        return np
    except Exception as exc:
        raise RuntimeError("numpy is required in the debuggee process: %s" % exc)

def __cvp_stats(array, np):
    try:
        if np.issubdtype(array.dtype, np.number) or np.issubdtype(array.dtype, np.bool_):
            numeric = array.astype("float64", copy=False)
            finite = numeric[np.isfinite(numeric)]
            if finite.size:
                return {
                    "min": float(finite.min()),
                    "max": float(finite.max())
                }
    except Exception:
        pass
    return {}

def __cvp_to_uint8(array, np):
    if array.dtype == np.bool_:
        return array.astype("uint8") * 255

    if array.dtype == np.uint8:
        return array

    numeric = array.astype("float32", copy=False)
    finite = numeric[np.isfinite(numeric)]

    if finite.size == 0:
        return np.zeros(numeric.shape, dtype="uint8")

    finite_min = float(finite.min())
    finite_max = float(finite.max())
    numeric = np.nan_to_num(numeric, nan=finite_min, posinf=finite_max, neginf=finite_min)

    if finite_min == finite_max:
        return np.zeros(numeric.shape, dtype="uint8")

    if finite_min >= 0.0 and finite_max <= 1.0:
        scaled = numeric * 255.0
    elif finite_min >= 0.0 and finite_max <= 255.0:
        scaled = numeric
    else:
        scaled = (numeric - finite_min) * (255.0 / (finite_max - finite_min))

    return np.clip(scaled, 0, 255).astype("uint8")

def __cvp_normalize_shape(array, np, channel_order):
    if array.ndim == 2:
        return array, "L", "HW"

    if array.ndim != 3:
        raise ValueError("Expected shape (H, W), (H, W, C), (C, H, W), or a batch (N, H, W, C) / (N, C, H, W); got %s" % (array.shape,))

    if array.shape[-1] in (1, 3, 4):
        channel_count = int(array.shape[-1])
        layout = "HWC"
    elif array.shape[0] in (1, 3, 4):
        array = np.moveaxis(array, 0, -1)
        channel_count = int(array.shape[-1])
        layout = "CHW"
    else:
        raise ValueError("Could not identify image channels in shape %s" % (array.shape,))

    if channel_count == 1:
        return array[:, :, 0], "L", layout
    if channel_count == 3:
        if channel_order == "BGR":
            array = array[:, :, ::-1]
        return array, "RGB", layout
    if channel_count == 4:
        if channel_order == "BGR":
            array = array[:, :, [2, 1, 0, 3]]
        return array, "RGBA", layout

    raise ValueError("Unsupported channel count: %s" % channel_count)

def __cvp_encode_with_pillow(array, mode):
    from PIL import Image
    image = Image.fromarray(array, mode=mode)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()

def __cvp_encode_with_cv2(array, mode):
    import cv2
    if mode == "RGB":
        encoded_array = array[:, :, ::-1]
    elif mode == "RGBA":
        encoded_array = array[:, :, [2, 1, 0, 3]]
    else:
        encoded_array = array
    ok, encoded = cv2.imencode(".png", encoded_array)
    if not ok:
        raise ValueError("cv2.imencode failed")
    return encoded.tobytes()

def __cvp_write_temp_png(png_bytes):
    temp_file = tempfile.NamedTemporaryFile(prefix="cv-preview-", suffix=".png", delete=False)
    try:
        temp_file.write(png_bytes)
        return temp_file.name
    finally:
        temp_file.close()

def __cvp_array_from_value(value, np):
    original_type = type(value).__module__ + "." + type(value).__name__
    pil_mode = None

    try:
        from PIL import Image
        if isinstance(value, Image.Image):
            pil_mode = value.mode
            array = np.asarray(value)
        else:
            array = np.asarray(value)
    except Exception:
        array = np.asarray(value)

    return array, original_type, pil_mode

def __cvp_encode_array_as_image(array, np, channel_order, original_type, pil_mode):
    if array.dtype == object:
        raise ValueError("Object arrays cannot be previewed as images")

    metadata = {
        "type": original_type,
        "shape": list(array.shape),
        "dtype": str(array.dtype),
        "channelOrder": channel_order
    }
    metadata.update(__cvp_stats(array, np))

    normalized, mode, layout = __cvp_normalize_shape(array, np, channel_order)
    image_array = np.ascontiguousarray(__cvp_to_uint8(normalized, np))
    metadata["layout"] = layout
    metadata["mode"] = mode
    if pil_mode is not None:
        metadata["pilMode"] = pil_mode

    try:
        png_bytes = __cvp_encode_with_pillow(image_array, mode)
        encoder = "Pillow"
    except Exception as pillow_exc:
        try:
            png_bytes = __cvp_encode_with_cv2(image_array, mode)
            encoder = "OpenCV"
        except Exception as cv2_exc:
            raise RuntimeError("PNG encoding requires Pillow or OpenCV. Pillow error: %s. OpenCV error: %s" % (pillow_exc, cv2_exc))

    metadata["encoder"] = encoder
    image_path = __cvp_write_temp_png(png_bytes)

    return {
        "ok": True,
        "kind": "image",
        "mime": "image/png",
        "imagePath": image_path,
        "metadata": metadata
    }

def __cvp_encode_one_image_item(value, channel_order, np):
    try:
        array, original_type, pil_mode = __cvp_array_from_value(value, np)
        return __cvp_encode_array_as_image(array, np, channel_order, original_type, pil_mode)
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "metadata": {
                "type": type(value).__module__ + "." + type(value).__name__
            }
        }

def __cvp_encode_images(items, channel_order, np):
    total_count = len(items)
    truncated = total_count > __CVP_MAX_BATCH_ITEMS
    limited = items[:__CVP_MAX_BATCH_ITEMS]
    encoded = [__cvp_encode_one_image_item(item, channel_order, np) for item in limited]

    return {
        "ok": True,
        "kind": "images",
        "items": encoded,
        "metadata": {
            "batchSize": total_count,
            "totalCount": total_count,
            "truncated": truncated
        }
    }

def __cvp_split_batch(array, np):
    if array.shape[-1] in (1, 3, 4):
        return [array[i] for i in range(array.shape[0])]
    if array.shape[1] in (1, 3, 4):
        moved = np.moveaxis(array, 1, -1)
        return [moved[i] for i in range(moved.shape[0])]
    return None

def __cvp_encode_table(value):
    import pandas as pd
    df = value.to_frame() if isinstance(value, pd.Series) else value

    total_rows = len(df)
    truncated = total_rows > __CVP_MAX_TABLE_ROWS
    preview_df = df.head(__CVP_MAX_TABLE_ROWS)
    safe_df = preview_df.astype(object).where(pd.notnull(preview_df), None)

    table = {
        "columns": [str(c) for c in preview_df.columns],
        "rows": safe_df.values.tolist(),
        "rowCount": total_rows,
        "truncated": truncated
    }

    metadata = {
        "type": "pandas.DataFrame" if isinstance(value, pd.DataFrame) else "pandas.Series",
        "shape": list(df.shape),
        "dtypes": {str(c): str(t) for c, t in df.dtypes.items()}
    }

    return {
        "ok": True,
        "kind": "table",
        "table": table,
        "metadata": metadata
    }

def __cvp_classify(value):
    module = type(value).__module__ or ""
    type_name = type(value).__name__

    if module.startswith("pandas"):
        if type_name == "DataFrame":
            return "dataframe"
        if type_name == "Series":
            return "series"
        return None
    if module.startswith("torch"):
        return "tensor_torch"
    if module.startswith("tensorflow"):
        return "tensor_tf"
    if isinstance(value, (list, tuple)):
        return "sequence"
    return None

def __cvp_encode_image(value):
    channel_order = __cvp_channel_order
    classification = __cvp_classify(value)

    if classification in ("dataframe", "series"):
        return __cvp_encode_table(value)

    if classification == "sequence":
        np = __cvp_require_numpy()
        return __cvp_encode_images(list(value), channel_order, np)

    np = __cvp_require_numpy()
    extra_metadata = {}
    pil_mode = None

    if classification == "tensor_torch":
        array = value.detach().cpu().numpy()
        original_type = "torch.Tensor"
        extra_metadata = {"device": str(value.device), "requiresGrad": bool(value.requires_grad)}
    elif classification == "tensor_tf":
        array = value.numpy()
        original_type = type(value).__module__ + "." + type(value).__name__
    else:
        array, original_type, pil_mode = __cvp_array_from_value(value, np)

    if array.dtype == object:
        raise ValueError("Object arrays cannot be previewed as images")

    if array.ndim == 4:
        batch_items = __cvp_split_batch(array, np)
        if batch_items is not None:
            payload = __cvp_encode_images(batch_items, channel_order, np)
            if payload.get("metadata") is not None:
                payload["metadata"]["type"] = original_type
                payload["metadata"]["shape"] = list(array.shape)
                payload["metadata"]["dtype"] = str(array.dtype)
            return payload

    payload = __cvp_encode_array_as_image(array, np, channel_order, original_type, pil_mode)
    if payload.get("ok") and extra_metadata:
        payload["metadata"].update(extra_metadata)
    return payload

try:
    __cvp_payload = __cvp_encode_image(__cvp_value)
except Exception as exc:
    __cvp_payload = {
        "ok": False,
        "error": str(exc),
        "metadata": {
            "type": type(__cvp_value).__module__ + "." + type(__cvp_value).__name__
        }
    }

__cvp_result = json.dumps(__cvp_payload, default=__cvp_json_default, separators=(",", ":"))
`;

export function buildPythonEvaluateExpression(userExpression: string, channelOrder: ChannelOrder): string {
  const namespaceExpression = `{"__builtins__": __builtins__, "__cvp_value": (${userExpression}), "__cvp_channel_order": ${JSON.stringify(channelOrder)}}`;
  return `(lambda __cvp_ns: (exec(${JSON.stringify(HELPER_CODE)}, __cvp_ns, __cvp_ns), __cvp_ns["__cvp_result"])[1])(${namespaceExpression})`;
}

// Lightweight, size-independent classification used for hover: never encodes pixels or
// writes a temp file, so the result stays tiny regardless of array size (unlike the full
// preview pipeline above, whose base64 payload can be large enough to blow past VS Code's
// hover content size limit and silently truncate the rest of the hover markdown).
const METADATA_CODE = String.raw`
import json

def __cvp_json_default(value):
    try:
        return value.item()
    except Exception:
        return str(value)

def __cvp_classify(value):
    module = type(value).__module__ or ""
    type_name = type(value).__name__

    if module.startswith("pandas"):
        if type_name == "DataFrame":
            return "dataframe"
        if type_name == "Series":
            return "series"
        return None
    if module.startswith("torch"):
        return "tensor_torch"
    if module.startswith("tensorflow"):
        return "tensor_tf"
    if isinstance(value, (list, tuple)):
        return "sequence"
    return None

def __cvp_describe(value):
    classification = __cvp_classify(value)

    if classification in ("dataframe", "series"):
        import pandas as pd
        df = value.to_frame() if isinstance(value, pd.Series) else value
        return {
            "ok": True,
            "kind": "table",
            "metadata": {
                "type": "pandas.DataFrame" if isinstance(value, pd.DataFrame) else "pandas.Series",
                "shape": list(df.shape)
            }
        }

    if classification == "sequence":
        items = list(value)
        return {
            "ok": True,
            "kind": "images",
            "metadata": {
                "type": type(value).__module__ + "." + type(value).__name__,
                "totalCount": len(items)
            }
        }

    import numpy as np

    if classification == "tensor_torch":
        array = value.detach().cpu().numpy()
        original_type = "torch.Tensor"
    elif classification == "tensor_tf":
        array = value.numpy()
        original_type = type(value).__module__ + "." + type(value).__name__
    else:
        original_type = type(value).__module__ + "." + type(value).__name__
        array = np.asarray(value)

    if array.dtype == object:
        raise ValueError("Object arrays cannot be previewed as images")

    kind = "images" if array.ndim == 4 else "image"
    metadata = {"type": original_type, "shape": list(array.shape), "dtype": str(array.dtype)}
    if kind == "images":
        metadata["totalCount"] = int(array.shape[0])

    return {"ok": True, "kind": kind, "metadata": metadata}

try:
    __cvp_payload = __cvp_describe(__cvp_value)
except Exception as exc:
    __cvp_payload = {
        "ok": False,
        "error": str(exc),
        "metadata": {
            "type": type(__cvp_value).__module__ + "." + type(__cvp_value).__name__
        }
    }

__cvp_result = json.dumps(__cvp_payload, default=__cvp_json_default, separators=(",", ":"))
`;

export function buildPythonMetadataExpression(userExpression: string): string {
  const namespaceExpression = `{"__builtins__": __builtins__, "__cvp_value": (${userExpression})}`;
  return `(lambda __cvp_ns: (exec(${JSON.stringify(METADATA_CODE)}, __cvp_ns, __cvp_ns), __cvp_ns["__cvp_result"])[1])(${namespaceExpression})`;
}

// Generates a small thumbnail (longest side ≤ 96 px) encoded directly as base64 in the
// returned JSON — no temp file, no large payload — so any array can appear inline in a
// hover tooltip regardless of source resolution.
const HOVER_THUMBNAIL_CODE = String.raw`
import json
import io
import base64 as _b64

__CVP_THUMB_MAX_PX = 96

def __cvp_json_default(value):
    try: return value.item()
    except Exception: return str(value)

def __cvp_classify(value):
    module = type(value).__module__ or ""
    if module.startswith("torch"): return "tensor_torch"
    if module.startswith("tensorflow"): return "tensor_tf"
    return None

def __cvp_to_uint8(array, np):
    if array.dtype == np.bool_: return array.astype("uint8") * 255
    if array.dtype == np.uint8: return array
    f = array.astype("float32", copy=False)
    finite = f[np.isfinite(f)]
    if not finite.size: return np.zeros(f.shape, dtype="uint8")
    fmin, fmax = float(finite.min()), float(finite.max())
    f = np.nan_to_num(f, nan=fmin, posinf=fmax, neginf=fmin)
    if fmin == fmax: return np.zeros(f.shape, dtype="uint8")
    if fmin >= 0.0 and fmax <= 1.0: scaled = f * 255.0
    elif fmin >= 0.0 and fmax <= 255.0: scaled = f
    else: scaled = (f - fmin) * (255.0 / (fmax - fmin))
    return np.clip(scaled, 0, 255).astype("uint8")

def __cvp_normalize_shape(array, np, channel_order):
    if array.ndim == 2: return array, "L"
    if array.ndim == 3:
        if array.shape[-1] in (1, 3, 4):
            ch = int(array.shape[-1])
        elif array.shape[0] in (1, 3, 4):
            array = np.moveaxis(array, 0, -1)
            ch = int(array.shape[-1])
        else:
            raise ValueError("Cannot identify channels in shape %s" % (array.shape,))
        if ch == 1: return array[:, :, 0], "L"
        if ch == 3:
            if channel_order == "BGR": array = array[:, :, ::-1]
            return array, "RGB"
        if ch == 4:
            if channel_order == "BGR": array = array[:, :, [2, 1, 0, 3]]
            return array, "RGBA"
    raise ValueError("Unsupported shape: %s" % (array.shape,))

def __cvp_resize(array, mode, np):
    h, w = array.shape[:2]
    if max(h, w) <= __CVP_THUMB_MAX_PX: return array
    if h >= w:
        new_h, new_w = __CVP_THUMB_MAX_PX, max(1, round(w * __CVP_THUMB_MAX_PX / h))
    else:
        new_w, new_h = __CVP_THUMB_MAX_PX, max(1, round(h * __CVP_THUMB_MAX_PX / w))
    try:
        from PIL import Image
        img = Image.fromarray(array, mode=mode)
        return np.asarray(img.resize((new_w, new_h), 0))
    except Exception: pass
    try:
        import cv2
        return cv2.resize(array, (new_w, new_h), interpolation=cv2.INTER_NEAREST)
    except Exception: pass
    return array

def __cvp_encode_b64(array, mode):
    try:
        from PIL import Image
        img = Image.fromarray(array, mode=mode)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return _b64.b64encode(buf.getvalue()).decode("ascii")
    except Exception: pass
    try:
        import cv2
        enc = array[:, :, ::-1] if mode == "RGB" else (array[:, :, [2, 1, 0, 3]] if mode == "RGBA" else array)
        ok, encoded = cv2.imencode(".png", enc)
        if ok: return _b64.b64encode(encoded.tobytes()).decode("ascii")
    except Exception: pass
    raise RuntimeError("PNG encoding requires Pillow or OpenCV")

def __cvp_make_thumbnail(value):
    channel_order = __cvp_channel_order
    classification = __cvp_classify(value)
    import numpy as np
    if classification == "tensor_torch":
        array = value.detach().cpu().numpy()
        original_type = "torch.Tensor"
    elif classification == "tensor_tf":
        array = value.numpy()
        original_type = type(value).__module__ + "." + type(value).__name__
    else:
        try:
            from PIL import Image
            if isinstance(value, Image.Image):
                if value.mode not in ("L", "RGB", "RGBA", "I", "F", "1"):
                    value = value.convert("RGBA" if value.mode == "PA" else "RGB")
                array = np.asarray(value)
            else:
                array = np.asarray(value)
        except Exception:
            array = np.asarray(value)
        original_type = type(value).__module__ + "." + type(value).__name__

    if array.dtype == object:
        raise ValueError("Object arrays cannot be previewed")

    original_shape = list(array.shape)
    if array.ndim == 4:
        if array.shape[-1] in (1, 3, 4): array = array[0]
        elif array.shape[1] in (1, 3, 4): array = np.moveaxis(array, 1, -1)[0]
        else: raise ValueError("Cannot identify channels in batch shape %s" % (original_shape,))

    metadata = {"type": original_type, "shape": original_shape, "dtype": str(array.dtype)}
    try:
        if np.issubdtype(array.dtype, np.number) or np.issubdtype(array.dtype, np.bool_):
            num = array.astype("float64", copy=False)
            finite = num[np.isfinite(num)]
            if finite.size:
                metadata["min"] = float(finite.min())
                metadata["max"] = float(finite.max())
    except Exception: pass

    normalized, mode = __cvp_normalize_shape(array, np, channel_order)
    display = np.ascontiguousarray(__cvp_to_uint8(normalized, np))
    thumb = __cvp_resize(display, mode, np)
    b64 = __cvp_encode_b64(thumb, mode)
    return {"ok": True, "kind": "image", "mime": "image/png", "base64": b64, "metadata": metadata}

try:
    __cvp_payload = __cvp_make_thumbnail(__cvp_value)
except Exception as exc:
    __cvp_payload = {"ok": False, "error": str(exc), "metadata": {"type": type(__cvp_value).__module__ + "." + type(__cvp_value).__name__}}

__cvp_result = json.dumps(__cvp_payload, default=__cvp_json_default, separators=(",", ":"))
`;

export function buildPythonHoverThumbnailExpression(userExpression: string, channelOrder: ChannelOrder): string {
  const namespaceExpression = `{"__builtins__": __builtins__, "__cvp_value": (${userExpression}), "__cvp_channel_order": ${JSON.stringify(channelOrder)}}`;
  return `(lambda __cvp_ns: (exec(${JSON.stringify(HOVER_THUMBNAIL_CODE)}, __cvp_ns, __cvp_ns), __cvp_ns["__cvp_result"])[1])(${namespaceExpression})`;
}
