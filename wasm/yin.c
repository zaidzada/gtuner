/*
 * yin.c — YIN pitch detector, freestanding WebAssembly.
 *
 * No libc, no malloc, no imports. All buffers are static; JavaScript writes
 * samples directly into linear memory via input_ptr() and reads the result
 * back from output_ptr(). The entire FFI surface is the three exported
 * functions at the bottom of this file.
 *
 * Algorithm (de Cheveigné & Kawahara 2002):
 *   1. squared difference function       d(tau)
 *   2. cumulative mean normalization     d'(tau)   <- kills octave errors
 *   3. absolute threshold + local min descent
 *   4. parabolic interpolation           <- sub-sample precision
 *
 * Build: ./build.sh
 */

#define NMAX   4096   /* longest analysis window we accept                  */
#define TAUMAX 1100   /* lag ceiling: 44100/1100 = 40 Hz detection floor.
                         Covers drop tunings with room to spare, and halves
                         the inner loop versus a naive n/2.                 */

static float g_in[NMAX];
static float g_cmnd[TAUMAX];
static float g_out[4];        /* freq, clarity, rms, tau */

/* Reject anything quieter than this before doing any work. */
#define RMS_GATE 0.005f

__attribute__((export_name("input_ptr")))
float *input_ptr(void) { return g_in; }

__attribute__((export_name("output_ptr")))
float *output_ptr(void) { return g_out; }

__attribute__((export_name("frame_size")))
int frame_size(void) { return NMAX; }

/*
 * Returns 1 and fills g_out when a pitch is found, 0 otherwise.
 *   n   - number of valid samples in g_in (<= NMAX)
 *   sr  - sample rate in Hz
 *   thr - YIN absolute threshold, typically 0.10 - 0.20
 */
__attribute__((export_name("detect")))
int detect(int n, float sr, float thr)
{
    if (n > NMAX) n = NMAX;

    int tau_max = n / 2;
    if (tau_max > TAUMAX) tau_max = TAUMAX;

    /* --- 0. level gate ------------------------------------------------- */
    float energy = 0.0f;
    for (int i = 0; i < n; i++) energy += g_in[i] * g_in[i];
    float rms = __builtin_sqrtf(energy / (float)n);
    g_out[2] = rms;
    if (rms < RMS_GATE) { g_out[0] = 0.0f; g_out[1] = 0.0f; return 0; }

    /* --- 1 & 2. difference function, normalized as we go ---------------- */
    const int w = n - tau_max;          /* comparison window length */
    float running = 0.0f;
    g_cmnd[0] = 1.0f;

    for (int tau = 1; tau < tau_max; tau++) {
        float sum = 0.0f;
        const float *a = g_in;
        const float *b = g_in + tau;
        for (int i = 0; i < w; i++) {
            float diff = a[i] - b[i];
            sum += diff * diff;
        }
        running += sum;
        g_cmnd[tau] = (running > 0.0f) ? sum * (float)tau / running : 1.0f;
    }

    /* --- 3. first dip below threshold, descended to its local minimum --- */
    int tau = -1;
    for (int t = 2; t < tau_max - 1; t++) {
        if (g_cmnd[t] < thr) {
            while (t + 1 < tau_max - 1 && g_cmnd[t + 1] < g_cmnd[t]) t++;
            tau = t;
            break;
        }
    }

    /* No dip cleared the threshold: fall back to the global minimum, but
       only trust it if it is at least somewhat periodic. */
    if (tau < 0) {
        float best = 1.0e30f;
        for (int t = 2; t < tau_max - 1; t++) {
            if (g_cmnd[t] < best) { best = g_cmnd[t]; tau = t; }
        }
        if (tau < 2 || best > 0.5f) { g_out[0] = 0.0f; g_out[1] = 0.0f; return 0; }
    }

    /* --- 4. parabolic interpolation around the minimum ------------------ */
    float x0 = g_cmnd[tau - 1];
    float x1 = g_cmnd[tau];
    float x2 = g_cmnd[tau + 1];
    float denom = 2.0f * (2.0f * x1 - x2 - x0);
    float shift = (denom != 0.0f) ? (x2 - x0) / denom : 0.0f;
    if (shift > 1.0f || shift < -1.0f) shift = 0.0f;

    float period = (float)tau + shift;
    if (period <= 0.0f) { g_out[0] = 0.0f; g_out[1] = 0.0f; return 0; }

    g_out[0] = sr / period;
    g_out[1] = 1.0f - x1;     /* clarity: 1 = perfectly periodic */
    g_out[3] = period;
    return 1;
}
