"""Charge-based junction diode used by the incremental MNA solver.

The supported subset follows the junction diode equations in the ngspice
manual, chapter 7. It is not an ngspice interface: forward/reverse conduction,
series resistance, depletion charge, transit-time charge and temperature are
evaluated directly. Avalanche is an exponential branch calibrated at BV/IBV.
https://ngspice.sourceforge.io/docs/ngspice-46-manual.pdf
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from .constants import QE
from .external_circuit_schema import number

KB = 1.380649e-23

DEFAULT_MODEL = {"IS": 1e-14, "N": 1., "RS": .1, "IBV": 1e-3,
                 "CJO": 1e-12, "VJ": 1., "M": .5, "TT": 0., "EG": 1.11,
                 "XTI": 3., "FC": .5, "TNOM": 27.}
MODEL_UNITS = {"IS": "A", "N": "1", "RS": "Ω", "BV": "V", "IBV": "A",
               "CJO": "F", "VJ": "V", "M": "1", "TT": "s", "EG": "eV",
               "XTI": "1", "FC": "1", "TNOM": "°C"}


def _exponential(x: float) -> tuple[float, float, float]:
    """exp(x)-1, its derivative, and its integral from zero.

    Tangent continuation outside the Newton iteration's exponential range
    avoids overflow. A converged operating point outside that range is rejected.
    """
    if x > 100:
        e = math.exp(100)
        d = x - 100
        return e * (1 + d) - 1, e, e - 1 - 100 + (e - 1) * d + .5 * e * d * d
    if x < -100:
        return -1., 0., -1. - x
    return math.expm1(x), math.exp(x), math.expm1(x) - x


def _power_integral(w: float, exponent: float) -> float:
    """Integral of z**(exponent-1) over [w,1], including the log limit."""
    return -math.log(w) if abs(exponent) < 1e-12 else -math.expm1(exponent * math.log(w)) / exponent


@dataclass(frozen=True)
class DiodeModel:
    parameters: dict

    @classmethod
    def parse(cls, parameters: dict) -> "DiodeModel":
        if not isinstance(parameters, dict):
            raise ValueError("ダイオードパラメータはオブジェクトで指定してください")
        unknown = set(parameters) - {"area", "temperature_k", "model_parameters"}
        if unknown:
            raise ValueError("未対応のダイオード設定: " + ", ".join(sorted(unknown)))
        area = number(parameters.get("area", 1), "ダイオード面積倍率", positive=True)
        temperature = parameters.get("temperature_k")
        if temperature is not None:
            temperature = number(temperature, "ダイオード温度 [K]", positive=True)
        source = parameters.get("model_parameters", {})
        if not isinstance(source, dict):
            raise ValueError("ダイオード model_parameters はオブジェクトで指定してください")
        model = dict(DEFAULT_MODEL)
        normalized = set()
        for key, value in source.items():
            key = str(key).upper()
            if key in normalized or key not in MODEL_UNITS:
                raise ValueError(f"未対応または重複したダイオードモデルパラメータ: {key}")
            normalized.add(key)
            if value is None:
                continue
            model[key] = number(value, "ダイオード " + key,
                                positive=key in {"IS", "N", "BV", "IBV", "VJ", "EG"},
                                nonnegative=key in {"RS", "CJO", "M", "TT"})
        if not 0 <= model["FC"] < 1 or model["TNOM"] <= -273.15:
            raise ValueError("ダイオード FC は0以上1未満、TNOM は−273.15°Cより大きくしてください")
        return cls({"area": area, "temperature_k": temperature, "model_parameters": model})

    def at_temperature(self, global_temperature_k: float) -> "JunctionDiode":
        return JunctionDiode(self, self.parameters["temperature_k"] or global_temperature_k)


class JunctionDiode:
    def __init__(self, model: DiodeModel, temperature_k: float):
        self.model = model
        self.p = model.parameters["model_parameters"]
        self.area = model.parameters["area"]
        self.temperature_k = float(temperature_k)
        self.vt = KB * self.temperature_k / QE
        nominal = self.p["TNOM"] + 273.15
        nominal_vt = KB * nominal / QE
        if self.vt <= 0 or nominal_vt <= 0 or self.p["N"] * self.vt <= 0:
            raise ValueError("ダイオード温度・理想係数が計算可能範囲を超えています")
        log_factor = (self.p["EG"] * (1 / nominal_vt - 1 / self.vt)
                      + self.p["XTI"] * math.log(self.temperature_k / nominal)) / self.p["N"]
        if abs(log_factor) > 500:
            raise ValueError("ダイオードの温度補正が計算可能範囲を超えています")
        self.saturation_a = self.p["IS"] * self.area * math.exp(log_factor)
        self.nvt = self.p["N"] * self.vt
        self.series_ohm = self.p["RS"] / self.area
        eg_nom = 1.16 - 7.02e-4 * nominal * nominal / (nominal + 1108)
        eg_t = 1.16 - 7.02e-4 * self.temperature_k ** 2 / (self.temperature_k + 1108)
        self.junction_potential_v = (self.p["VJ"] * self.temperature_k / nominal
            - self.vt * (3 * math.log(self.temperature_k / nominal) + eg_nom / nominal_vt - eg_t / self.vt))
        if not math.isfinite(self.junction_potential_v) or self.junction_potential_v <= 0:
            raise ValueError("ダイオード温度補正後の接合電位が非正です。温度またはVJを見直してください")
        correction = 1 + self.p["M"] * (4e-4 * (self.temperature_k - nominal)
            - (self.junction_potential_v - self.p["VJ"]) / self.p["VJ"])
        if correction <= 0:
            raise ValueError("ダイオード温度補正後の接合容量が不正です")
        self.zero_capacitance_f = self.p["CJO"] * self.area * correction
        if self.saturation_a <= 0 or not all(math.isfinite(x) for x in (self.saturation_a, self.zero_capacitance_f, self.nvt, self.series_ohm)):
            raise ValueError("ダイオードの物理量が計算可能範囲を超えています")

    def conduction(self, voltage_v: float) -> tuple[float, float]:
        f, df, _ = _exponential(voltage_v / self.nvt)
        current = self.saturation_a * f
        conductance = self.saturation_a * df / self.nvt
        if "BV" in self.p:
            # This smooth branch approaches zero before breakdown and gives
            # exactly IBV*area at Vj=-BV (up to the tiny Shockley leakage).
            f_reverse, d_reverse, _ = _exponential((-voltage_v - self.p["BV"]) / self.nvt)
            current -= self.p["IBV"] * self.area * (f_reverse + 1)
            conductance += self.p["IBV"] * self.area * d_reverse / self.nvt
        return current, conductance

    def limit_iteration_voltage(self, proposed: float, previous: float) -> float:
        """Logarithmic PN-junction limiting, for Newton iterates only.

        The final solution is evaluated with the actual node voltage. Limiting
        avoids dozens of constant thermal-voltage Newton steps after a pulse.
        """
        def limit_forward(new, old, saturation):
            critical = self.nvt * math.log(max(1., self.nvt / (math.sqrt(2) * saturation)))
            if new > critical and abs(new - old) > 2 * self.nvt:
                if old > 0:
                    argument = 1 + (new - old) / self.nvt
                    return old + self.nvt * math.log(argument) if argument > 0 else critical
                return self.nvt * math.log(max(new / self.nvt, 1.))
            return new
        limited = limit_forward(proposed, previous, self.saturation_a)
        if "BV" in self.p and limited < -self.p["BV"]:
            forward = -limited - self.p["BV"]
            old = max(0., -previous - self.p["BV"])
            limited = -self.p["BV"] - limit_forward(forward, old, self.p["IBV"] * self.area)
        return limited

    def charge(self, voltage_v: float) -> tuple[float, float, float]:
        """Junction charge [C], dQ/dV [F], stored electric energy [J]."""
        c0, vj, m, fc = self.zero_capacitance_f, self.junction_potential_v, self.p["M"], self.p["FC"]
        limit = fc * vj
        v = min(voltage_v, limit)
        w = 1 - v / vj
        q = c0 * vj * _power_integral(w, 1 - m)
        capacitance = c0 * w ** (-m)
        energy = c0 * vj * vj * (_power_integral(w, 1 - m) - _power_integral(w, 2 - m))
        if voltage_v > limit:
            delta = voltage_v - limit
            slope = capacitance * m / (vj * (1 - fc))
            q += capacitance * delta + .5 * slope * delta * delta
            energy += limit * capacitance * delta + .5 * (capacitance + limit * slope) * delta * delta + slope * delta ** 3 / 3
            capacitance += slope * delta
        if voltage_v > 0 and self.p["TT"]:
            f, df, integral = _exponential(voltage_v / self.nvt)
            scale = self.p["TT"] * self.saturation_a
            q += scale * f
            capacitance += scale * df / self.nvt
            energy += scale * (voltage_v * f - self.nvt * integral)
        return q, capacitance, max(0., energy)

    def assert_exponential_range(self, voltage_v: float):
        if voltage_v / self.nvt > 100 or ("BV" in self.p and (-voltage_v - self.p["BV"]) / self.nvt > 100):
            raise ValueError("ダイオード接合の電流が計算範囲を超えました。直列抵抗RSまたは回路条件を見直してください")

    def metadata(self) -> dict:
        return {"model": "charge-based Shockley diode with exponential avalanche",
            "parameters": self.model.parameters, "temperature_k": self.temperature_k,
            "thermal_voltage_v": self.vt, "effective_saturation_current_a": self.saturation_a,
            "effective_series_resistance_ohm": self.series_ohm,
            "effective_junction_potential_v": self.junction_potential_v,
            "effective_zero_bias_capacitance_f": self.zero_capacitance_f,
            "assumptions": ["接合電荷を後退Eulerで積分。温度は指定値に固定。", "逆降伏はBV/IBVに合わせた指数近似。ngspice全モデル・熱回路・soft recoveryは含まない。"]}
