import numpy as np
from skimage import color, data, transform


img = data.astronaut()
coffee = data.coffee()
camera = data.camera()
coins = data.coins()
moon = data.moon()

float_img = img.astype(np.float32) / 255.0
gray_from_color = color.rgb2gray(coffee).astype(np.float32)
small_img = transform.resize(img, (128, 128), anti_aliasing=True).astype(np.float32)
chw = np.moveaxis(img, -1, 0)

breakpoint()

print(
    "Preview variables named img, coffee, camera, coins, moon, "
    "float_img, gray_from_color, small_img, or chw."
)
