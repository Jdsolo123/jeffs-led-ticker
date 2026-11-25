import time, threading, config, data_fetcher, renderer
from PIL import Image
from rgbmatrix import RGBMatrix, RGBMatrixOptions

def _make_matrix():
    opts = RGBMatrixOptions()
    opts.rows = config.ROWS
    opts.cols = config.COLS
    opts.chain_length = config.CHAIN
    opts.parallel = config.PARALLEL
    opts.hardware_mapping = config.HW_MAPPING
    opts.gpio_slowdown = config.GPIO_SLOWDOWN
    opts.disable_hardware_pulsing = True
    return RGBMatrix(options=opts)

def crop_window(canvas_img, offset):
    W = config.TOTAL_WIDTH
    H = config.ROWS
    total = canvas_img.width
    x = int(offset) % total
    if x + W <= total:
        return canvas_img.crop((x, 0, x + W, H))
    right = canvas_img.crop((x, 0, total, H))
    left  = canvas_img.crop((0, 0, W - right.width, H))
    merged = Image.new('RGB', (W, H))
    merged.paste(right, (0, 0))
    merged.paste(left, (right.width, 0))
    return merged

def main():
    matrix = _make_matrix()
    offscreen = matrix.CreateFrameCanvas()

    canvas_lock = threading.Lock()
    canvas_holder = [renderer.build_canvas([])]

    def _refresh():
        while True:
            time.sleep(config.UPDATE_SECS)
            try:
                games = data_fetcher.fetch_all()
                new_canvas = renderer.build_canvas(games)
                with canvas_lock:
                    canvas_holder[0] = new_canvas
            except Exception as e:
                print(f'refresh error: {e}')

    threading.Thread(target=_refresh, daemon=True).start()

    # Initial fetch
    try:
        games = data_fetcher.fetch_all()
        with canvas_lock:
            canvas_holder[0] = renderer.build_canvas(games)
    except Exception:
        pass

    offset = 0.0
    frame_time = 1.0 / config.FPS

    while True:
        t0 = time.time()
        with canvas_lock:
            canvas = canvas_holder[0]
        window = crop_window(canvas, offset)
        offscreen.SetImage(window.convert('RGB'))
        offscreen = matrix.SwapOnVSync(offscreen)
        offset += config.SCROLL_SPEED_PPS * frame_time
        elapsed = time.time() - t0
        sleep = frame_time - elapsed
        if sleep > 0:
            time.sleep(sleep)

if __name__ == '__main__':
    main()
