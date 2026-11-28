/**
 * The live preview's GPU pipeline (issue 2619): one full-screen pass that
 * maps every output pixel back onto the base image (an affine matrix from
 * editMath.inverseAffine) and runs editMath.scenePixel and outputPixel there,
 * the server's formulas. What depends only on the sliders (the white balance
 * matrix, levels, the shoulder) is worked out once in JS (editMath.prepare)
 * and handed over as uniforms. The detail texture (log luminance and its two
 * blurs) is built once per photo on the CPU with the server's blur, so a
 * slider move costs exactly one draw.
 *
 * GLSL ES 1.00, which WebGL2 runs as well. The textures of a RAW are
 * half-float linear (WebGL2 only); WebGL1 shows the 8-bit base without the
 * detail texture.
 */

export const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `
precision highp float;

uniform sampler2D u_image;
uniform sampler2D u_detail;
uniform vec2 u_srcSize;
uniform vec2 u_outSize;
// Output pixel -> source pixel: x = dot(u_mapX, (px, py, 1)), y likewise.
uniform vec3 u_mapX;
uniform vec3 u_mapY;
uniform float u_linear;
uniform float u_baseline;
uniform float u_hasDetail;
uniform mat3 u_matrix;
// clarity, sharpen, shadows, highlights (slider / 100)
uniform vec4 u_local;
// gamma, whites, blacks, saturation
uniform vec4 u_tone;
// vibrance, bw, white level, black level
uniform vec4 u_ends;
uniform float u_shoulder;
// sigmoid n, phi, e
uniform vec3 u_sigmoid;
uniform float u_plain;
uniform vec3 u_background;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float G0 = 0.1845;
const float LOG_G0 = -2.4382726;

float toLinear(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
float toSrgb(float l) {
  return l <= 0.0031308 ? 12.92 * l : 1.055 * pow(l, 1.0 / 2.4) - 0.055;
}
float level(float y) {
  return log2(max(y, 1.0 / 65536.0));
}
float limiter(float d, float s) {
  return d / (1.0 + (d / s) * (d / s));
}
float coring(float d, float t) {
  return (d * d) / (d * d + t * t);
}
float sigmoidCurve(float x) {
  float p = pow(max(x, 0.0) + u_sigmoid.y, u_sigmoid.x);
  return p / (p + u_sigmoid.z);
}
float skinWeight(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  if (mx <= mn) return 0.0;
  float d = mx - mn;
  float hue;
  if (mx == c.r) hue = mod((c.g - c.b) / d, 6.0);
  else if (mx == c.g) hue = (c.b - c.r) / d + 2.0;
  else hue = (c.r - c.g) / d + 4.0;
  hue *= 60.0;
  if (hue < 0.0) hue += 360.0;
  float away = min(abs(hue - 25.0), 360.0 - abs(hue - 25.0));
  return exp(-(away / 15.0) * (away / 15.0));
}

void main() {
  vec3 outPx = vec3(gl_FragCoord.x, u_outSize.y - gl_FragCoord.y, 1.0);
  vec2 src = vec2(dot(u_mapX, outPx), dot(u_mapY, outPx));
  if (src.x < -0.5 || src.y < -0.5 || src.x > u_srcSize.x + 0.5 || src.y > u_srcSize.y + 0.5) {
    gl_FragColor = vec4(u_background, 1.0);
    return;
  }
  vec2 uv = src / u_srcSize;
  vec3 c = texture2D(u_image, uv).rgb;
  vec3 rgb = u_linear > 0.5 ? c * u_baseline : vec3(toLinear(c.r), toLinear(c.g), toLinear(c.b));
  if (u_plain > 0.5) {
    if (u_linear > 0.5) rgb = vec3(sigmoidCurve(rgb.r), sigmoidCurve(rgb.g), sigmoidCurve(rgb.b));
    gl_FragColor = vec4(toSrgb(clamp(rgb.r, 0.0, 1.0)), toSrgb(clamp(rgb.g, 0.0, 1.0)), toSrgb(clamp(rgb.b, 0.0, 1.0)), 1.0);
    return;
  }
  float dc = 0.0;
  float ds = 0.0;
  if (u_hasDetail > 0.5) {
    vec3 d = texture2D(u_detail, uv).rgb;
    dc = d.r - d.g;
    ds = d.r - d.b;
  }

  rgb = u_matrix * rgb;
  float y = dot(rgb, LUMA);
  float lv = level(y);
  float local = limiter(dc, 0.7);
  float detail = 0.0;
  if (u_local.x != 0.0 || u_local.y != 0.0) {
    float gate = smoothstep(-11.0, -8.0, lv) * (u_linear > 0.5 ? 1.0 : 1.0 - smoothstep(0.9, 1.0, y));
    if (u_local.x > 0.0) detail += 1.6 * u_local.x * local * coring(dc, 0.05) * gate;
    else if (u_local.x < 0.0) detail += 0.6 * u_local.x * dc;
    if (u_local.y != 0.0) detail += 1.2 * u_local.y * limiter(ds, 0.25) * coring(ds, 0.02) * gate;
    detail /= 1.0 + abs(detail);
  }
  float zone = lv - 0.7 * local - LOG_G0;
  float shift = detail;
  shift += 1.5 * u_local.w * smoothstep(0.0, 3.0, zone);
  if (u_local.z != 0.0) {
    shift += 1.5 * u_local.z * (1.0 - smoothstep(-5.0, 0.0, zone)) * (u_local.z > 0.0 ? smoothstep(-12.0, -8.5, zone) : 1.0);
  }
  rgb *= exp2(shift);

  if (u_tone.x != 1.0) {
    y = dot(rgb, LUMA);
    if (y > 0.0) rgb *= G0 * pow(y / G0, u_tone.x) / y;
  }

  if (u_tone.y != 0.0 || u_tone.z != 0.0) {
    float end = level(dot(rgb, LUMA)) - 0.7 * local;
    float ends = u_tone.y * smoothstep(u_ends.z - 3.0, u_ends.z, end);
    if (u_tone.z < 0.0) ends += 1.5 * u_tone.z * (1.0 - smoothstep(u_ends.w, u_ends.w + 4.0, end));
    rgb *= exp2(ends);
    if (u_tone.z > 0.0) rgb += vec3(0.0025 * u_tone.z);
  }

  y = dot(rgb, LUMA);
  float mx = max(rgb.r, max(rgb.g, rgb.b));
  float mn = min(rgb.r, min(rgb.g, rgb.b));
  float k = 1.0 + u_tone.w;
  float chroma = (mx - mn) / max(mx, 1e-6);
  if (u_ends.x > 0.0) k *= 1.0 + u_ends.x * (1.0 - chroma) * (1.0 - chroma) * (1.0 - 0.5 * skinWeight(rgb));
  else if (u_ends.x < 0.0) k *= 1.0 + u_ends.x * smoothstep(0.05, 0.75, chroma);
  if (mn < 0.0 && y > 0.0) k = min(k, y / (y - mn));
  rgb = vec3(y) + k * (rgb - vec3(y));
  if (u_ends.y > 0.5) rgb = vec3(dot(rgb, LUMA));

  if (u_linear > 0.5) {
    // The sigmoid per channel, the middle channel kept where the hue had it.
    float hi = max(rgb.r, max(rgb.g, rgb.b));
    float lo = min(rgb.r, min(rgb.g, rgb.b));
    float mid = rgb.r + rgb.g + rgb.b - hi - lo;
    float t = hi > lo ? (mid - lo) / (hi - lo) : 0.0;
    vec3 curved = vec3(sigmoidCurve(rgb.r), sigmoidCurve(rgb.g), sigmoidCurve(rgb.b));
    float outHi = sigmoidCurve(hi);
    float outLo = sigmoidCurve(lo);
    float outMid = outLo + t * (outHi - outLo);
    if (hi > lo) {
      // Which channel is the middle one: neither the largest nor the smallest.
      if (rgb.r != hi && rgb.r != lo) curved.r = outMid;
      else if (rgb.g != hi && rgb.g != lo) curved.g = outMid;
      else if (rgb.b != hi && rgb.b != lo) curved.b = outMid;
    }
    rgb = curved;
  } else if (u_shoulder > 1.0) {
    float peak = max(rgb.r, max(rgb.g, rgb.b));
    if (peak > 0.8) {
      float u = (peak - 0.8) / 0.2;
      float top = (u_shoulder - 0.8) / 0.2;
      float mapped = 0.8 + 0.2 * (u * (1.0 + u / (top * top))) / (1.0 + u);
      rgb *= mapped / peak;
    }
  }
  rgb = clamp(rgb, 0.0, 1.0);
  gl_FragColor = vec4(toSrgb(rgb.r), toSrgb(rgb.g), toSrgb(rgb.b), 1.0);
}
`;
