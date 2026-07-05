import numpy as np


height = 180
width = 260

y = np.linspace(0, 1, height, dtype=np.float32)[:, None]
x = np.linspace(0, 1, width, dtype=np.float32)[None, :]

img = np.zeros((height, width, 3), dtype=np.float32)
img[..., 0] = x
img[..., 1] = y
img[..., 2] = 0.35

gray = np.sin(x * 18) * np.cos(y * 12)
chw = np.transpose(img, (2, 0, 1))

breakpoint()

# Step over these lines with Live refresh on to watch the preview panel update automatically.
img = np.clip(img + 0.15, 0, 1)
img = np.clip(img * 0.5, 0, 1)
gray = -gray

print("Preview variables named img, gray, or chw from the debugger.")
