#!/usr/bin/env python3
"""通知音を一から合成する(著作物のサンプルは使わない)。出力: sounds/*.wav (44.1kHz 16bit ステレオ)

  brass-low   … 低い金管のような重厚な和音がゆっくり立ち上がる(Zimmer 系の雰囲気)
  organ-swell … パイプオルガンのような和音の膨らみ(『Interstellar』の雰囲気)
  sub-hit     … 深い低音の一撃と長い残響(『Inception』の雰囲気)
  her-piano   … 柔らかく疎らなピアノ風の音と静かな余韻(『Her』の雰囲気)
  her-pad     … 温かいシンセのパッドがふわっと広がる
"""
import os
import wave

import numpy as np
from scipy.signal import fftconvolve, lfilter

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sounds")
rng = np.random.default_rng(7)


def hz(note):  # "D2" -> Hz
    names = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
    n, o = (note[:2], int(note[2:])) if note[1] == "#" else (note[0], int(note[1:]))
    return 440.0 * 2 ** ((names[n] + 12 * (o + 1) - 69) / 12)


def t_(d):
    return np.arange(int(SR * d)) / SR


def env(d, a, r, curve=2.0):
    t = t_(d)
    e = np.minimum(1.0, t / a) ** curve * np.minimum(1.0, (d - t) / r) ** 1.5
    return np.clip(e, 0, 1)


def reverb(x, seconds=3.0, wet=0.4, damp=0.55):
    """合成した残響(減衰するノイズと畳み込み。高域ほど早く減衰)"""
    n = int(SR * seconds)
    t = np.arange(n) / SR
    ir = rng.standard_normal((2, n)) * np.exp(-t * 6.9 / seconds)
    for ch in range(2):  # 高域を削って温かく
        ir[ch] = lfilter([1 - damp], [1, -damp], ir[ch])
    ir /= np.sqrt((ir**2).sum(axis=1, keepdims=True))
    dry = np.stack([x, x])
    wetsig = np.stack([fftconvolve(x, ir[0]), fftconvolve(x, ir[1])])
    out = np.zeros((2, wetsig.shape[1]))
    out[:, : dry.shape[1]] += dry * (1 - wet)
    out += wetsig * wet
    return out


def save(name, y, fade=True):
    y = y / (np.abs(y).max() + 1e-9) * 0.82
    f = int(SR * 0.05)
    if fade:
        y[:, -f:] *= np.linspace(1, 0, f)
    pcm = (y.T * 32767).astype("<i2")
    os.makedirs(OUT, exist_ok=True)
    with wave.open(os.path.join(OUT, name + ".wav"), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
    print(f"{name}: {y.shape[1] / SR:.1f}s")


def brass(freq, d, a=0.7, r=1.0, bright=0.8):
    """金管風: ノコギリ波を重ね、明るさ(倍音)を立ち上がりに合わせて開く"""
    t = t_(d)
    e = env(d, a, r, 1.6)
    y = np.zeros_like(t)
    for detune in (-0.004, 0.0, 0.004):
        f = freq * (1 + detune)
        for n in range(1, 24):
            amp = (1 / n) * np.exp(-n * (1 - bright * e) * 0.35)
            y += amp * np.sin(2 * np.pi * f * n * t + n * 0.3)
    y += 0.9 * np.sin(2 * np.pi * freq * 0.5 * t)  # 1オクターブ下の土台
    return y * e


def organ(freq, d, a=1.0, r=1.2):
    t = t_(d)
    y = np.zeros_like(t)
    for h, amp in ((1, 1.0), (2, 0.8), (3, 0.5), (4, 0.45), (6, 0.25), (8, 0.18), (0.5, 0.6)):
        y += amp * np.sin(2 * np.pi * freq * h * t + h)
    y *= 1 + 0.03 * np.sin(2 * np.pi * 5.2 * t)  # ごく浅い揺れ
    return y * env(d, a, r, 1.3)


def piano(freq, d=2.5, vel=0.8):
    """ピアノ風: 倍音が時間とともに減る。やや非調和で温かい"""
    t = t_(d)
    y = np.zeros_like(t)
    for n in range(1, 12):
        f = freq * n * np.sqrt(1 + 0.0004 * n * n)
        y += (1 / n**1.3) * np.sin(2 * np.pi * f * t) * np.exp(-t * (1.2 + 0.9 * n))
    y *= (1 - np.exp(-t * 400))  # 打鍵の立ち上がり
    return y * vel


def pad(freq, d, a=1.6, r=1.6):
    t = t_(d)
    y = np.zeros_like(t)
    for detune in (-0.006, -0.002, 0.002, 0.006):
        y += np.sin(2 * np.pi * freq * (1 + detune) * t) + 0.3 * np.sin(2 * np.pi * freq * 2 * (1 + detune) * t)
    return y * env(d, a, r, 1.4)


def place(total, parts):
    y = np.zeros(int(SR * total))
    for start, sig in parts:
        i = int(SR * start)
        y[i : i + len(sig)] += sig[: len(y) - i]
    return y


def bandnoise(n, lo, hi, r):
    """lo〜hi Hz の帯域のノイズ(打撃の鋭さ)"""
    from scipy.signal import butter, sosfilt
    sos = butter(2, [lo, hi], btype="band", fs=SR, output="sos")
    return sosfilt(sos, r.standard_normal(n))


def clock_tick(seed, d=0.25):
    """時計の針の「チッ」: 軽く、短く、高め。低音はほとんど無し。鋭い2連の打撃 + 金属の小さな共鳴"""
    r = np.random.default_rng(seed)
    t = t_(d)
    y = np.zeros_like(t)
    # 1) 鋭い打撃 2連(爪が当たる → 落ちる)。数ミリ秒で消える
    gap = 0.011 + r.uniform(-0.0008, 0.0008)
    for delay, g in ((0.0, 1.0), (gap, 0.5)):
        i = int(SR * delay)
        n = len(t) - i
        y[i:] += g * bandnoise(n, 2200, 7500, r) * np.exp(-np.arange(n) / SR * 2400) * 2.0
    # 2) 金属部品の小さな共鳴(「チ」の芯。高めで短い)
    for f, g, dec in ((920, 0.30, 85), (1380, 0.22, 110), (2150, 0.12, 150), (3300, 0.06, 220)):
        y += g * np.sin(2 * np.pi * f * (1 + r.uniform(-0.01, 0.01)) * t) * np.exp(-t * dec) * (1 - np.exp(-t * 4000))
    # 3) 低音はごく薄く(箱の存在感だけ)
    y += 0.10 * np.sin(2 * np.pi * 310 * t) * np.exp(-t * 110)
    return y * (1 + r.uniform(-0.04, 0.04))


def room(x, size="small"):
    """部屋の響き: 初期反射(壁からの返り)+ 減衰する残響"""
    taps = {"small": [(0.011, 0.35), (0.023, 0.25), (0.037, 0.18)], "hall": [(0.021, 0.4), (0.047, 0.3), (0.083, 0.22), (0.131, 0.15)]}[size]
    y = x.copy()
    for dly, g in taps:
        i = int(SR * dly)
        y[i:] += x[:-i] * g
    return reverb(y, 0.35 if size == "small" else 1.1, 0.16 if size == "small" else 0.26, damp=0.6)


def make_tick(name, size):
    r = np.random.default_rng(11)
    parts = []
    for k in range(8):
        jitter = r.normal(0, 0.0015)  # 振り子の揺れ: ごくわずか
        parts.append((max(0.0, k * 1.0 + jitter), clock_tick(100 + k)))
    y = place(8.0, parts)
    stereo = room(y, size)[:, : int(SR * 8)]
    stereo = stereo + 0.0015 * rng.standard_normal(stereo.shape)  # ごく小さな部屋の空気の音
    save(name, stereo, fade=False)


def soft_note(freq, d=7.0, vel=0.5):
    """考え中の音: 丸くて柔らかい鐘/ピアノ風の1音。打鍵の角を丸めて、ゆっくり減衰"""
    t = t_(d)
    y = np.zeros_like(t)
    for n, g in ((1, 1.0), (2, 0.35), (3, 0.12), (4.01, 0.06)):
        y += g * np.sin(2 * np.pi * freq * n * t) * np.exp(-t * (0.55 + 0.5 * n))
    y *= np.minimum(1.0, t / 0.025) ** 1.5  # 立ち上がりをわずかに丸める
    return y * vel


def thinking_demo(seconds=48, seed=5):
    """A. 生成的な環境音: 小さなパッドが静かに鳴り続け、D メジャーペンタトニックの音が不規則な間隔で1つずつ落ちる"""
    r = np.random.default_rng(seed)
    total = seconds
    # パッド(D3 A3 D4 の和音。ゆっくり揺れる)。非常に小さく
    bed = sum(pad(hz(n), total, a=6.0, r=5.0) * g for n, g in (("D3", 1.0), ("A3", 0.7), ("D4", 0.45)))
    bed = bed / np.abs(bed).max() * 0.18
    scale = ["D4", "E4", "F#4", "A4", "B4", "D5", "E5", "F#5", "A5"]
    parts = []
    t = 2.0
    last = -1
    while t < total - 7:
        i = int(r.integers(0, len(scale)))
        while abs(i - last) < 1:  # 同じ音を続けない
            i = int(r.integers(0, len(scale)))
        last = i
        parts.append((t, soft_note(hz(scale[i]), 7.0, float(r.uniform(0.25, 0.5)))))
        t += float(r.uniform(4.0, 10.0))  # 4〜10秒おき: 拍にならない不規則さ
    notes = place(total, parts)
    return bed + notes * 0.55


def heartbeat_demo(seconds=40, bpm=50):
    """B. 低い鼓動: とても低い「ドッ・ドッ」(2打で1拍)。深い残響"""
    period = 60.0 / bpm
    def thump(f0, d=0.5, g=1.0):
        t = t_(d)
        f = f0 * np.exp(-t * 7) + f0 * 0.55
        return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 11) * g
    parts = []
    k = 0.0
    while k < seconds - 2:
        parts.append((k, thump(62, 0.5, 1.0)))
        parts.append((k + 0.32, thump(55, 0.5, 0.65)))
        k += period
    return place(seconds, parts)


MATERIALS = {
    # 名前: (共鳴の高さの範囲, (倍率, 強さ, 減衰) の並び, 長さ, ざらつき)
    "wood":    ((820, 1500),  ((1.0, 1.0, 140), (2.31, 0.5, 230), (4.1, 0.2, 380)),   0.12, 0.50),   # 木のビーズ: 丸く温かい
    "glass":   ((2300, 3700), ((1.0, 1.0, 70),  (2.76, 0.45, 110), (5.4, 0.22, 170)), 0.20, 0.35),   # ガラスのビー玉: 明るく硬い
    "ceramic": ((1500, 2600), ((1.0, 1.0, 95),  (2.2, 0.5, 160),  (3.9, 0.25, 260)),  0.16, 0.45),   # 陶器: 中間の硬さ
    "metal":   ((3000, 5200), ((1.0, 1.0, 38),  (2.9, 0.55, 65),  (5.1, 0.3, 120)),   0.30, 0.25),   # 小さな金属球: 澄んで長く響く
    "stone":   ((480, 1050),  ((1.0, 1.0, 260), (1.7, 0.4, 330)),                      0.09, 1.00),   # 小石: 低くざらつく
    "seeds":   ((4200, 8000), ((1.0, 0.5, 520),),                                       0.05, 1.60),   # 種(サラサラ): ほぼ雑音の細かい音
    "bamboo":  ((560, 1100),  ((1.0, 1.0, 55),  (2.0, 0.42, 90),  (3.01, 0.2, 150)),  0.22, 0.30),   # 竹筒: 中が空洞で、丸く響く
    "coin":    ((4800, 7600), ((1.0, 1.0, 45),  (2.4, 0.5, 80),   (4.7, 0.3, 140)),   0.26, 0.18),   # 薄い金属板(コイン): 高く鋭く、短く鳴る
    "shell":   ((1800, 3400), ((1.0, 0.8, 190), (1.9, 0.5, 260),  (3.3, 0.3, 380)),   0.08, 1.10),   # 小さな貝殻: 乾いて軽い、ざらつく
}


def impact(kind, r):
    """転がる粒が当たる1回の音。素材ごとに共鳴の高さと減衰が違う。毎回わずかに違う"""
    kind = "ceramic" if kind == "bowl" else kind
    (lo, hi), modes, d, tick = MATERIALS[kind]
    f = r.uniform(lo, hi)
    t = t_(d)
    y = np.zeros_like(t)
    for m, g, dec in modes:
        y += g * np.sin(2 * np.pi * f * m * (1 + r.uniform(-0.03, 0.03)) * t) * np.exp(-t * dec)
    y += tick * lfilter([0.5], [1, -0.5], r.standard_normal(len(t))) * np.exp(-t * 900)  # 当たった瞬間のざらつき
    return y * (1 - np.exp(-t * 4000))


def roll_burst(kind, r):
    """1回の「コロコロ…」: まばらに始まり、密になり、また疎になって止まる"""
    d = float(r.uniform(1.0, 2.6))
    peak = 26
    if kind == "seeds":  # サラサラ: 細かい粒がたくさん
        d, peak = float(r.uniform(0.9, 2.0)), 90
    if kind == "bowl":  # 鉢の中を転がる玉: 長く、だんだん速くなって収束する
        d, peak = float(r.uniform(2.6, 4.2)), 44
    n_grid = int(d * 400)
    x = np.linspace(0, 1, n_grid)
    rate = 4 + peak * np.sin(np.pi * x) ** 2  # 毎秒4〜(4+peak)回
    if kind == "bowl":
        rate = 4 + peak * x**2.2 * np.exp(-3.0 * (x - 1) ** 2)  # 終わりに向かって加速
    cum = np.cumsum(rate) / 400  # 期待される衝突回数の累積
    total = int(cum[-1])
    events = [float(x[np.searchsorted(cum, k + r.uniform(0.2, 1.0))]) * d for k in range(total) if k + 0.5 < cum[-1]]
    out = np.zeros(int(SR * (d + 0.3)))
    for et in events:
        a = (0.35 + 0.65 * np.sin(np.pi * et / d)) * r.uniform(0.35, 1.0)  # 真ん中ほど強く
        sig = impact(kind, r) * a
        i = int(SR * et)
        out[i : i + len(sig)] += sig[: len(out) - i]
    return out


def rolling_demo(kind, seconds=44, seed=3):
    r = np.random.default_rng(seed)
    parts, t = [], 1.0
    while t < seconds - 4:
        parts.append((t, roll_burst(kind, r)))
        t += float(r.uniform(3.0, 7.5))  # 次の「コロコロ」まで3〜7秒。拍にならない
    return place(seconds, parts)


def bell(freq, d=3.0, vel=0.5):
    """柔らかい鐘(ガラス寄り): 非整数倍の倍音をゆっくり減衰させる"""
    t = t_(d)
    y = np.zeros_like(t)
    for m, g, dec in ((1.0, 1.0, 1.1), (2.76, 0.28, 2.0), (5.4, 0.1, 3.4)):
        y += g * np.sin(2 * np.pi * freq * m * t) * np.exp(-t * dec)
    return y * np.minimum(1.0, t / 0.012) * vel


def banks():
    """完了・確認待ち・大きな完了の音を、複数のバリエーションで書き出す(毎回ランダムに選ぶ)"""
    for d in ("done", "ask", "big"):
        os.makedirs(os.path.join(OUT, d), exist_ok=True)
    penta = ["D", "E", "F#", "A", "B"]  # D メジャーペンタトニックの仲間(どれを重ねても濁らない)

    def put(kind, i, y, wet, secs):
        save_path = os.path.join(OUT, kind, f"{kind}-{i}.wav")
        st = reverb(y, secs, wet)
        st = st / (np.abs(st).max() + 1e-9) * 0.82
        f = int(SR * 0.05)
        st[:, -f:] *= np.linspace(1, 0, f)
        with wave.open(save_path, "wb") as w:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((st.T * 32767).astype("<i2").tobytes())

    # done: 温かいパッドの和音(ルートを変える)/ パッド + 鐘 / ピアノの上昇アルペジオ
    roots = ["A", "D", "E", "F#", "B", "G", "C", "F"]
    for i, root in enumerate(roots):
        r = np.random.default_rng(200 + i)
        style = ("pad", "padbell", "arp")[i % 3]
        o = 3
        tones = [f"{root}{o}", f"{root}{o + 1}", ] 
        # ルート・5度・9度(add9)を作る: 半音数で計算
        base = hz(f"{root}{o}")
        chord = [base, base * 2 ** (7 / 12), base * 2 ** (14 / 12), base * 2 ** (16 / 12)]  # root, 5th, 9th, #10(≒長3度上)
        if style == "pad":
            y = sum(pad(f, 2.4, a=0.5, r=1.3) * g for f, g in zip(chord, (1.0, 0.8, 0.6, 0.4)))
        elif style == "padbell":
            y = sum(pad(f, 2.4, a=0.5, r=1.3) * g for f, g in zip(chord, (1.0, 0.8, 0.5, 0.3)))
            y = y / np.abs(y).max()
            y += place(2.6, [(0.35, bell(chord[2] * 2, 2.2, 0.5))])[: len(y)] * 0.0 if False else 0
            y = np.pad(y, (0, 0))
            b = place(2.4, [(0.3, bell(chord[2] * 2, 2.0, 0.35)), (0.55, bell(chord[1] * 2, 2.0, 0.28))])
            y[: len(b)] += b[: len(y)]
        else:  # arp: 上昇する3音のピアノ
            notes = [chord[0] * 2, chord[1] * 2, chord[2] * 2]
            y = place(3.2, [(0.0, piano(notes[0], 2.4, 0.7)), (0.26, piano(notes[1], 2.4, 0.65)), (0.52, piano(notes[2], 2.6, 0.7))])
        put("done", i, y, 0.42, 2.4)

    # ask: 解決しない上がり調子の問い。音程(4度・5度・6度・2度)と高さ、楽器(ピアノ/鐘)を変える
    asks = [("B4", 5, "p"), ("E4", 7, "p"), ("A4", 5, "b"), ("D5", 7, "b"), ("F#4", 9, "p"), ("G4", 5, "p"), ("C#5", 7, "b"), ("E5", 5, "b")]
    for i, (start, semis, inst) in enumerate(asks):
        f1 = hz(start); f2 = f1 * 2 ** (semis / 12)
        mk = (lambda f, d, v: piano(f, d, v)) if inst == "p" else (lambda f, d, v: bell(f, d, v))
        gap = 0.38 + 0.08 * (i % 3)
        y = place(3.0, [(0.0, mk(f1, 2.0, 0.7)), (gap, mk(f2, 2.4, 0.75))])
        put("ask", i, y, 0.45, 2.4)

    # big: オルガンの膨らみ。調と声部を変える(滅多に鳴らないので、長めで重厚に)
    bigs = [("D", (0, 7, 12, 16, 19, 24)), ("E", (0, 7, 12, 16, 19, 24)), ("A", (0, 7, 12, 14, 19, 24)), ("F", (0, 7, 12, 16, 21, 24))]
    for i, (root, voicing) in enumerate(bigs):
        base = hz(f"{root}2")
        y = sum(organ(base * 2 ** (v / 12), 3.0, a=0.9, r=1.4) * (1.0 - 0.1 * k) for k, v in enumerate(voicing))
        put("big", i, y, 0.45, 3.4)
    print("banks:", {d: len(os.listdir(os.path.join(OUT, d))) for d in ("done", "ask", "big")})


def main():
    only_think = os.environ.get("ONLY_THINK") == "1"
    # 1) brass-low: D 短調の低い和音(D2 + A2 + D3 + F3)。重く、短め
    y = sum(brass(hz(n), 2.2, a=0.75, r=1.1) * g for n, g in (("D2", 1.0), ("A2", 0.7), ("D3", 0.6), ("F3", 0.35)))
    save("brass-low", reverb(y, 3.2, 0.38)[:, : int(SR * 4.5)] if False else reverb(y, 3.2, 0.38))

    # 2) organ-swell: D メジャーの広い響き(D2 A2 D3 F#3 A3 D4)
    y = sum(organ(hz(n), 3.2) * g for n, g in (("D2", 1.0), ("A2", 0.8), ("D3", 0.8), ("F#3", 0.5), ("A3", 0.5), ("D4", 0.4)))
    save("organ-swell", reverb(y, 4.0, 0.45))

    # 3) sub-hit: 低音が沈む一撃 + 暗いノイズ + 長い残響
    t = t_(1.6)
    f = 52 * np.exp(-t * 1.1) + 28
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 2.2)
    noise = lfilter([0.04], [1, -0.96], rng.standard_normal(len(t))) * np.exp(-t * 5) * 6
    save("sub-hit", reverb(boom + 0.5 * noise, 3.6, 0.5))

    # 4) her-piano: 疎らな4音(E4 B4 F#5 B5)。余韻を長く
    notes = (("E4", 0.00, 0.8), ("B4", 0.55, 0.7), ("F#5", 1.15, 0.6), ("B5", 1.9, 0.5))
    y = place(5.0, [(s, piano(hz(n), 3.0, v)) for n, s, v in notes])
    save("her-piano", reverb(y, 3.6, 0.5))

    # 5) her-pad: A メジャー add9 がふわっと広がる(A3 E4 B4 C#5)
    y = sum(pad(hz(n), 3.6) * g for n, g in (("A3", 1.0), ("E4", 0.8), ("B4", 0.6), ("C#5", 0.5)))
    save("her-pad", reverb(y, 3.8, 0.45))

    # 6) done: her-pad の短い版(普通の作業の完了。立ち上がりを早め、全体を約3秒に)
    y = sum(pad(hz(n), 2.2, a=0.55, r=1.2) * g for n, g in (("A3", 1.0), ("E4", 0.8), ("B4", 0.6), ("C#5", 0.5)))
    save("done", reverb(y, 2.2, 0.42))

    # 7) ask: 確認待ち用。解決しない上がり調子の2音(B4 → F#5 は完全5度で上がって終わる =「どうする?」)
    y = place(3.0, [(0.0, piano(hz("B4"), 2.0, 0.7)), (0.42, piano(hz("F#5"), 2.4, 0.75))])
    save("ask", reverb(y, 2.4, 0.45))

    # 12) 考え中の音のバンク: 素材ごとに複数の「ひと転がり」を書き出す(プラグインがランダムに選んで鳴らす)
    os.makedirs(os.path.join(OUT, "think"), exist_ok=True)
    import zlib
    per = int(os.environ.get("THINK_PER", 12))
    for kind in ("wood", "glass", "ceramic", "metal", "stone", "seeds", "bowl", "bamboo", "coin", "shell"):
        for i in range(per):
            r = np.random.default_rng(1000 + zlib.crc32(kind.encode()) % 997 + i)
            burst = roll_burst(kind, r)
            st = room(burst, "small")[:, : int(SR * (len(burst) / SR + 0.4))]
            pan = r.uniform(0.35, 1.0)  # 左右にばらけさせる
            if r.random() < 0.5:
                st[0] *= pan
            else:
                st[1] *= pan
            st = st / (np.abs(st).max() + 1e-9) * 0.7
            f = int(SR * 0.06)
            st[:, -f:] *= np.linspace(1, 0, f)
            with wave.open(os.path.join(OUT, "think", f"{kind}-{i}.wav"), "wb") as w:
                w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((st.T * 32767).astype("<i2").tobytes())
    print("think bank:", len(os.listdir(os.path.join(OUT, "think"))), "files")

    # 11) 転がる音(デモ): 木のビーズ=コロコロ / ガラスのビー玉=カラカラ
    save("think-wood", room(rolling_demo("wood"), "small"), fade=True)
    save("think-glass", room(rolling_demo("glass", seed=9), "small"), fade=True)

    # 10) 考え中の音(デモ): A=生成的な環境音 / B=低い鼓動
    save("think-ambient", reverb(thinking_demo(), 3.5, 0.5), fade=True)
    save("think-heartbeat", reverb(heartbeat_demo(), 2.6, 0.45), fade=True)

    # 9) 時計の音(2種類): 小さな部屋 / 広い古い館
    make_tick("tick-loop", "small")
    make_tick("tick-hall", "hall")

    # 8) big: 長い作業の完了。organ-swell を少し短くしたもの(本当に大きな達成のときだけ)
    y = sum(organ(hz(n), 3.0, a=0.9, r=1.4) * g for n, g in (("D2", 1.0), ("A2", 0.8), ("D3", 0.8), ("F#3", 0.5), ("A3", 0.5), ("D4", 0.4)))
    save("big", reverb(y, 3.4, 0.45))


if __name__ == "__main__":
    main()
    banks()
