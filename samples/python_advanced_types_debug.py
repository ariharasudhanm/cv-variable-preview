import numpy as np
import pandas as pd

height = 96
width = 96

base = np.zeros((height, width, 3), dtype=np.uint8)
base[..., 0] = np.linspace(0, 255, width, dtype=np.uint8)[None, :]
base[..., 1] = np.linspace(0, 255, height, dtype=np.uint8)[:, None]
base[..., 2] = 80

variant_a = base.copy()
variant_b = np.clip(base.astype(np.int16) + 40, 0, 255).astype(np.uint8)
variant_c = base[: height // 2, : width // 2]

batch = np.stack([base, variant_a, variant_b])
image_list = [base, variant_c]

df = pd.DataFrame({
    "id": range(5),
    "score": [0.91, 0.42, np.nan, 0.77, 0.05],
    "label": ["cat", "dog", "cat", None, "fox"]
})
series = df["score"]

try:
    import torch
    torch_tensor = torch.from_numpy(base.copy())
except ImportError:
    torch_tensor = None

# try:
#     import tensorflow as tf
#     tf_tensor = tf.convert_to_tensor(base.copy())
# except ImportError:
#     tf_tensor = None

breakpoint()

print(
    "Preview df, series, batch, image_list, torch_tensor, or tf_tensor from the debugger "
    "(torch_tensor/tf_tensor are None if those libraries aren't installed)."
)
