#!/usr/bin/env python3
"""モデル段階の開始音を合成する。出力: sounds/chime-{high,mid,low}.wav (44.1kHz 16bit モノ)。
段階が上がるほど大きな乗り物になる。いずれも不規則なゆらぎ(グラつき)は入れない: 毎回聞くので癖を避ける。

  high … ロケット点火。52Hz の重い一撃(頭だけ音程が落ちる)+ 低いノイズの残響(2.9秒)。
         ノート PC のスピーカーやイヤホンは 80Hz 以下を再生できないので、倍音(104/156/208Hz)と
         200Hz 付近のノイズで「重さ」を出している。基音だけだと無音に近い
  mid  … ジェット旅客機の巡航。420Hz 付近の低い風切りが滑らかに膨らんで消える(1.4秒)。一番よく鳴るので最も癖がない
  low  … ドローン。240Hz の羽根の唸り(ずれなし)+ 風切りの息(0.75秒、頭から減衰)

音量はファイルでは RMS を揃え、段階ごとの大小は chime.sh の afplay -v で付ける。
"""
import os
import wave

import numpy as np
from scipy.signal import butter, fftconvolve, lfilter, sosfilt

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sounds")
rng = np.random.default_rng(11)  # 生成順(high → mid → low)を変えると high の残響ノイズが変わる


def t_(d):
    return np.arange(int(SR * d)) / SR


def unit(x):
    return x / x.std()


def lowpass(x, fc, order=4):
    return sosfilt(butter(order, fc / (SR / 2), output="sos"), x)


def normalize(y, rms=0.12):
    loud = np.abs(y) > 0.05 * np.abs(y).max()
    y = y * rms / np.sqrt((y[loud] ** 2).mean())  # 雑音系はピークだけで揃えると小さくなるので RMS で揃える
    return y * min(1, 0.95 / np.abs(y).max())


def write(name, y):
    with wave.open(os.path.join(OUT, name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((y * 32767).astype("<i2").tobytes())


def tone(freqs, amps, taus, d, a, drop=0.0, drop_tau=0.06):
    t = t_(d)
    y = np.zeros_like(t)
    for f, amp, tau in zip(freqs, amps, taus):
        ph = 2 * np.pi * np.cumsum(f * (1 + drop * np.exp(-t / drop_tau))) / SR  # drop=0.6 なら開始時 1.6 倍の高さから f へ落ちる
        y += amp * np.sin(ph) * np.exp(-t / tau)
    return y * np.minimum(1, t / a) * np.minimum(1, (d - t) / 0.15)


def low_noise(d, fc=200):
    return unit(lowpass(rng.standard_normal(int(SR * d)), fc, 3))


def bandpass(x, fc, q):
    """周波数 fc の帯域だけ通す(Chamberlin の状態変数フィルタ)。"""
    f1 = 2 * np.sin(np.pi * fc / SR)
    low = band = 0.0
    out = np.empty_like(x)
    for i in range(len(x)):
        low += f1 * band
        high = x[i] - low - band / q
        band += f1 * high
        out[i] = band
    return out


def high(d=2.3, tail=0.6, wet=0.15, rt=0.7):
    t = t_(d)
    y = tone([52, 104, 156, 208], [1, 0.8, 0.5, 0.3], [0.9, 0.6, 0.4, 0.25], d, a=0.02, drop=0.6, drop_tau=0.08)
    y += 0.5 * low_noise(d) * (1 - np.exp(-t / 0.1)) * np.exp(-t / 0.7)
    y = np.concatenate([y, np.zeros(int(SR * tail))])
    n = int(SR * rt)
    b, a = butter(2, 2000 / (SR / 2))
    ir = lfilter(b, a, rng.standard_normal(n)) * np.exp(-np.arange(n) / SR / (rt / 4))  # 合成した残響
    y = y + wet * fftconvolve(y, ir / np.sqrt((ir**2).sum()))[: len(y)]
    y *= np.minimum(1, (len(y) - np.arange(len(y))) / (SR * 0.3))
    return normalize(y)


def mid(d=1.4):
    t = t_(d)
    env = np.minimum(1, t / 0.35) ** 2 * np.minimum(1, (d - t) / 0.5) ** 2  # 滑らかに膨らんで消える(両端 0)
    return normalize(lowpass(unit(bandpass(rng.standard_normal(len(t)), 420, 0.7)), 1000) * env)


def low(d=0.75, f=240):
    t = t_(d)
    env = np.minimum(1, t / 0.06) ** 2 * np.exp(-t / 0.22) * np.minimum(1, (d - t) / 0.12) ** 2  # 一定音量から急に切らず、連続して減衰させる
    ph = 2 * np.pi * f * t
    hum = lowpass(sum(np.sin(k * ph) / k**0.9 for k in range(1, 11)), 3000)  # 羽根の通過周波数の倍音列
    air = sosfilt(butter(2, [1000 / (SR / 2), 4000 / (SR / 2)], "band", output="sos"), rng.standard_normal(len(t)))
    return normalize((unit(hum) + 0.12 * unit(air)) * env)


write("chime-high.wav", high())
write("chime-mid.wav", mid())
write("chime-low.wav", low())
