/*
 * enhance_icons.c - fast Stream Deck icon enhancer.
 * Reads a tab-separated manifest (appid, icon path, optional art path) and
 * writes a 144x144 PNG per icon: blurred/darkened art backdrop with the
 * upscaled (denoised) app icon centered. Prints {"done":[...]} and exits.
 *
 * Requires stb_image.h, stb_image_write.h, stb_image_resize2.h (vendored).
 * Build: cc -O2 -s -flto -o enhance_icons enhance_icons.c -lm
 */
#define STB_IMAGE_IMPLEMENTATION
#include "../vendor/stb_image.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "../vendor/stb_image_write.h"
#define STB_IMAGE_RESIZE2_IMPLEMENTATION
#include "../vendor/stb_image_resize2.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>
#include <sys/stat.h>

#define CANVAS    144
#define ICON_BOX  112

static void mkdirs(const char *dir)
{
    char tmp[4096];
    snprintf(tmp, sizeof tmp, "%s", dir);
    size_t len = strlen(tmp);
    if (len && tmp[len - 1] == '/') tmp[len - 1] = 0;
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = 0;
            mkdir(tmp, 0755);
            *p = '/';
        }
    }
    if (len) mkdir(tmp, 0755);
}

static unsigned char *resize_uc(const unsigned char *src, int iw, int ih, int ch, int ow, int oh, const char *label)
{
    unsigned char *out = malloc((size_t)ow * oh * ch);
    if (!out) {
        fprintf(stderr, "%s: malloc failed\n", label);
        return NULL;
    }
    stbir_pixel_layout layout = ch == 4 ? STBIR_RGBA : STBIR_RGB;
    void *ok = stbir_resize(src, iw, ih, iw * ch,
                            out, ow, oh, ow * ch,
                            layout, STBIR_TYPE_UINT8, STBIR_EDGE_CLAMP, STBIR_FILTER_CATMULLROM);
    if (!ok) {
        fprintf(stderr, "%s: stbir_resize failed\n", label);
        free(out);
        return NULL;
    }
    return out;
}

static void gaussian_blur(unsigned char *img, int w, int h, int ch, double sigma, unsigned char *out)
{
    int rad = (int)ceil(sigma * 3.0);
    if (rad < 1) rad = 1;
    int ksize = 2 * rad + 1;
    double *k = malloc(sizeof(double) * (size_t)ksize);
    double sum = 0.0;
    for (int i = -rad; i <= rad; i++) {
        k[i + rad] = exp(-(double)(i * i) / (2.0 * sigma * sigma));
        sum += k[i + rad];
    }
    for (int i = 0; i < ksize; i++) k[i] /= sum;

    unsigned char *tmp = malloc((size_t)w * h * ch);
    /* horizontal */
    for (int y = 0; y < h; y++) {
        unsigned char *row = img + (size_t)y * w * ch;
        for (int x = 0; x < w; x++) {
            for (int c = 0; c < ch; c++) {
                double acc = 0.0;
                for (int i = 0; i < ksize; i++) {
                    int sx = x + i - rad;
                    if (sx < 0) sx = 0;
                    if (sx >= w) sx = w - 1;
                    acc += k[i] * row[sx * ch + c];
                }
                tmp[y * w * ch + x * ch + c] = (unsigned char)(acc + 0.5);
            }
        }
    }
    /* vertical */
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            for (int c = 0; c < ch; c++) {
                double acc = 0.0;
                for (int i = 0; i < ksize; i++) {
                    int sy = y + i - rad;
                    if (sy < 0) sy = 0;
                    if (sy >= h) sy = h - 1;
                    acc += k[i] * tmp[sy * w * ch + x * ch + c];
                }
                out[y * w * ch + x * ch + c] = (unsigned char)(acc + 0.5);
            }
        }
    }
    free(tmp);
    free(k);
}

static void unsharp_mask(unsigned char *img, int w, int h, int ch, double sigma, double amount, int threshold)
{
    unsigned char *blur = malloc((size_t)w * h * ch);
    gaussian_blur(img, w, h, ch, sigma, blur);
    for (int i = 0; i < w * h * ch; i++) {
        int d = img[i] - blur[i];
        if (d > threshold || d < -threshold) {
            int v = (int)(img[i] + amount * d);
            if (v < 0) v = 0;
            if (v > 255) v = 255;
            img[i] = (unsigned char)v;
        }
    }
    free(blur);
}

/* 3x3 median denoise, per channel, on an RGBA buffer. */
static void median_denoise(unsigned char *img, int w, int h)
{
    unsigned char *tmp = malloc((size_t)w * h * 4);
    unsigned char win[9];
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            int idx = 0;
            for (int dy = -1; dy <= 1; dy++) {
                int sy = y + dy;
                if (sy < 0) sy = 0;
                if (sy >= h) sy = h - 1;
                for (int dx = -1; dx <= 1; dx++) {
                    int sx = x + dx;
                    if (sx < 0) sx = 0;
                    if (sx >= w) sx = w - 1;
                    win[idx++] = img[(sy * w + sx) * 4];
                }
            }
            for (int a = 1; a < 9; a++) {
                unsigned char v = win[a];
                int b = a - 1;
                while (b >= 0 && win[b] > v) { win[b + 1] = win[b]; b--; }
                win[b + 1] = v;
            }
            tmp[(y * w + x) * 4 + 0] = win[4];
            idx = 0;
            for (int dy = -1; dy <= 1; dy++) {
                int sy = y + dy;
                if (sy < 0) sy = 0;
                if (sy >= h) sy = h - 1;
                for (int dx = -1; dx <= 1; dx++) {
                    int sx = x + dx;
                    if (sx < 0) sx = 0;
                    if (sx >= w) sx = w - 1;
                    win[idx++] = img[(sy * w + sx) * 4 + 1];
                }
            }
            for (int a = 1; a < 9; a++) {
                unsigned char v = win[a];
                int b = a - 1;
                while (b >= 0 && win[b] > v) { win[b + 1] = win[b]; b--; }
                win[b + 1] = v;
            }
            tmp[(y * w + x) * 4 + 1] = win[4];
            idx = 0;
            for (int dy = -1; dy <= 1; dy++) {
                int sy = y + dy;
                if (sy < 0) sy = 0;
                if (sy >= h) sy = h - 1;
                for (int dx = -1; dx <= 1; dx++) {
                    int sx = x + dx;
                    if (sx < 0) sx = 0;
                    if (sx >= w) sx = w - 1;
                    win[idx++] = img[(sy * w + sx) * 4 + 2];
                }
            }
            for (int a = 1; a < 9; a++) {
                unsigned char v = win[a];
                int b = a - 1;
                while (b >= 0 && win[b] > v) { win[b + 1] = win[b]; b--; }
                win[b + 1] = v;
            }
            tmp[(y * w + x) * 4 + 2] = win[4];
            tmp[(y * w + x) * 4 + 3] = img[(y * w + x) * 4 + 3];
        }
    }
    memcpy(img, tmp, (size_t)w * h * 4);
    free(tmp);
}

static void dominant_color(const unsigned char *px, int w, int h, int *r, int *g, int *b)
{
    double sr = 0, sg = 0, sb = 0;
    int n = w * h;
    for (int i = 0; i < n; i++) {
        sr += px[i * 4 + 0];
        sg += px[i * 4 + 1];
        sb += px[i * 4 + 2];
    }
    if (n < 1) n = 1;
    *r = (int)(sr / n);
    *g = (int)(sg / n);
    *b = (int)(sb / n);
}

int main(int argc, char **argv)
{
    const char *manifest = NULL, *outdir = NULL;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--manifest") && i + 1 < argc) manifest = argv[++i];
        else if (!strcmp(argv[i], "--outdir") && i + 1 < argc) outdir = argv[++i];
    }
    if (!manifest || !outdir) {
        fprintf(stderr, "usage: enhance_icons --manifest FILE --outdir DIR\n");
        return 2;
    }

    FILE *mf = fopen(manifest, "r");
    if (!mf) { perror(manifest); return 2; }

    mkdirs(outdir);

    char *outbuf = malloc(1 << 20);
    size_t outlen = 0;
    outlen += (size_t)snprintf(outbuf + outlen, (1 << 20) - outlen, "{\"done\":[");

    char line[8192];
    int done_any = 0;
    while (fgets(line, sizeof line, mf)) {
        line[strcspn(line, "\r\n")] = 0;
        if (!line[0]) continue;
        char *appid = strtok(line, "\t");
        char *iconp = strtok(NULL, "\t");
        char *artp = strtok(NULL, "\t");
        if (!appid || !iconp) { fprintf(stderr, "bad manifest line: %s\n", line); continue; }

        char outpath[4096];
        snprintf(outpath, sizeof outpath, "%s/%s.png", outdir, appid);

        int iw, ih;
        unsigned char *icon = stbi_load(iconp, &iw, &ih, NULL, 4);
        if (!icon) { fprintf(stderr, "%s: stbi_load icon failed (%s)\n", appid, stbi_failure_reason()); continue; }

        unsigned char *art = NULL;
        int aw = 0, ah = 0;
        if (artp && artp[0]) art = stbi_load(artp, &aw, &ah, NULL, 3);

        int r, g, b;
        dominant_color(icon, iw, ih, &r, &g, &b);

        unsigned char *bg = malloc((size_t)CANVAS * CANVAS * 3);
        if (art) {
            unsigned char *scaled = resize_uc(art, aw, ah, 3, CANVAS, CANVAS, appid);
            if (scaled) {
                memcpy(bg, scaled, (size_t)CANVAS * CANVAS * 3);
                free(scaled);
                unsigned char *blurtmp = malloc((size_t)CANVAS * CANVAS * 3);
                gaussian_blur(bg, CANVAS, CANVAS, 3, 7.0, blurtmp);
                memcpy(bg, blurtmp, (size_t)CANVAS * CANVAS * 3);
                free(blurtmp);
            }
            stbi_image_free(art);
        } else {
            /* fall back to darkened dominant color */
            for (int i = 0; i < CANVAS * CANVAS; i++) {
                bg[i * 3 + 0] = (unsigned char)(r * 0.28);
                bg[i * 3 + 1] = (unsigned char)(g * 0.28);
                bg[i * 3 + 2] = (unsigned char)(b * 0.28);
            }
        }
        /* darken backdrop */
        for (int i = 0; i < CANVAS * CANVAS * 3; i++) bg[i] = (unsigned char)(bg[i] * 0.45);

        /* fit icon into ICON_BOX box preserving aspect */
        double scale = (double)ICON_BOX / (iw > ih ? iw : ih);
        int fw = (int)(iw * scale + 0.5), fh = (int)(ih * scale + 0.5);
        if (fw < 1) fw = 1;
        if (fh < 1) fh = 1;

        unsigned char *big = resize_uc(icon, iw, ih, 4, fw, fh, appid);
        stbi_image_free(icon);
        if (!big) { free(bg); continue; }
        median_denoise(big, fw, fh);
        unsharp_mask(big, fw, fh, 4, 1.2, 1.2, 8);

        unsigned char *canvas = calloc((size_t)ICON_BOX * ICON_BOX * 4, 1);
        int ox = (ICON_BOX - fw) / 2, oy = (ICON_BOX - fh) / 2;
        for (int y = 0; y < fh; y++) {
            for (int x = 0; x < fw; x++) {
                unsigned char *dst = canvas + ((size_t)(oy + y) * ICON_BOX + (ox + x)) * 4;
                unsigned char *src = big + ((size_t)y * fw + x) * 4;
                dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2]; dst[3] = src[3];
            }
        }
        free(big);

        /* composite canvas (premultiplied) onto bg */
        int off = (CANVAS - ICON_BOX) / 2;
        for (int y = 0; y < ICON_BOX; y++) {
            for (int x = 0; x < ICON_BOX; x++) {
                unsigned char *src = canvas + ((size_t)y * ICON_BOX + x) * 4;
                unsigned char *dst = bg + ((size_t)(y + off) * CANVAS + (x + off)) * 3;
                int a = src[3];
                dst[0] = (unsigned char)((dst[0] * (255 - a) + src[0] * a) / 255);
                dst[1] = (unsigned char)((dst[1] * (255 - a) + src[1] * a) / 255);
                dst[2] = (unsigned char)((dst[2] * (255 - a) + src[2] * a) / 255);
            }
        }
        free(canvas);

        if (!stbi_write_png(outpath, CANVAS, CANVAS, 3, bg, CANVAS * 3)) {
            fprintf(stderr, "%s: stbi_write_png failed\n", appid);
        } else {
            outlen += (size_t)snprintf(outbuf + outlen, (1 << 20) - outlen, "%s\"%s\"", done_any ? "," : "", appid);
            done_any = 1;
        }
        free(bg);
    }
    fclose(mf);

    outlen += (size_t)snprintf(outbuf + outlen, (1 << 20) - outlen, "]}");
    printf("%s\n", outbuf);
    free(outbuf);
    return 0;
}