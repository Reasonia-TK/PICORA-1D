"""TEM coax geometry and passive Foster/Debye loss parameters.

The reference application's physical model is reproduced from its documented
equations, using our own incremental RLC implementation. Both shield ends are
one ideal reference: external common mode is outside this TEM model.
"""
from __future__ import annotations

import cmath
import math
from dataclasses import dataclass

from scipy.special import ive

from .constants import EPS0
from .external_circuit_schema import number

MU0 = 1.25663706212e-6
DEFAULT_COAX_PARAMETERS = {
    "inner_diameter_m": .001, "shield_inner_diameter_m": .00335,
    "length_m": 1., "relative_permittivity": 2.1, "relative_permeability": 1.,
    "loss_tangent": .0002, "inner_resistivity_ohm_m": 1.724e-8,
    "shield_resistivity_ohm_m": 1.724e-8, "shield_thickness_m": .00015,
    "reference_frequency_hz": 40e6, "segments": 32,
}


@dataclass(frozen=True)
class CoaxModel:
    parameters: dict
    inductance_h_m: float
    capacitance_f_m: float
    dc_resistance_ohm_m: float
    rf_resistance_ohm_m: float
    internal_reactance_ohm_m: float
    skin_resistance_ohm_m: float
    skin_inductance_h_m: float
    dielectric_capacitance_f_m: float
    relaxation_capacitance_f_m: float
    relaxation_resistance_ohm_m: float

    @classmethod
    def parse(cls, parameters: dict) -> "CoaxModel":
        try:
            model = cls._parse(parameters)
            if model.inductance_h_m <= 0 or model.capacitance_f_m <= 0:
                raise ValueError("同軸のインダクタンスと容量は正である必要があります")
            metadata = model.metadata()
            if not all(math.isfinite(v) for v in metadata.values() if isinstance(v, (float, int))):
                raise ValueError("同軸の伝搬定数が計算可能範囲を超えています")
            return model
        except (ZeroDivisionError, OverflowError, FloatingPointError) as exc:
            raise ValueError("同軸ケーブルの寸法・材料から有効な線路定数を計算できません") from exc

    @classmethod
    def _parse(cls, parameters: dict) -> "CoaxModel":
        if not isinstance(parameters, dict):
            raise ValueError("同軸ケーブルのパラメータはオブジェクトで指定してください")
        unknown = set(parameters) - set(DEFAULT_COAX_PARAMETERS)
        if unknown:
            raise ValueError("同軸ケーブルの未対応パラメータ: " + ", ".join(sorted(unknown)))
        zero_allowed = {"loss_tangent", "inner_resistivity_ohm_m", "shield_resistivity_ohm_m"}
        p = {k: number(parameters.get(k, v), "同軸 " + k,
                       positive=k not in zero_allowed, nonnegative=k in zero_allowed)
             for k, v in DEFAULT_COAX_PARAMETERS.items()}
        if p["shield_inner_diameter_m"] <= p["inner_diameter_m"]:
            raise ValueError("同軸シールド内径は内部導体直径より大きくしてください")
        if p["loss_tangent"] >= 1:
            raise ValueError("同軸の誘電正接は0以上1未満です")
        if not p["segments"].is_integer() or not 1 <= p["segments"] <= 256:
            raise ValueError("同軸ケーブルの分割数は1〜256の整数です")
        p["segments"] = int(p["segments"])
        a, b = p["inner_diameter_m"] / 2, p["shield_inner_diameter_m"] / 2
        logarithm = math.log(p["shield_inner_diameter_m"]) - math.log(p["inner_diameter_m"])
        l = MU0 * p["relative_permeability"] * logarithm / (2 * math.pi)
        c = 2 * math.pi * EPS0 * p["relative_permittivity"] / logarithm
        omega = 2 * math.pi * p["reference_frequency_hz"]
        thickness = p["shield_thickness_m"]
        r_inner = p["inner_resistivity_ohm_m"] / (math.pi * a * a)
        r_shield = p["shield_resistivity_ohm_m"] / (math.pi * thickness * (2 * b + thickness))
        z_inner = _inner_impedance(a, p["inner_resistivity_ohm_m"], omega, r_inner)
        z_shield = _shield_impedance(b, thickness, p["shield_resistivity_ohm_m"], omega, r_shield)
        z = z_inner + z_shield
        dc = r_inner + r_shield
        excess = max(0., z.real - dc)
        # Z_Foster = R || jwL; matching its real/imaginary parts at f_ref.
        if excess > max(dc * 1e-12, 1e-30) and z.imag > 0:
            skin_r = (excess * excess + z.imag * z.imag) / excess
            skin_l = (excess * excess + z.imag * z.imag) / (omega * z.imag)
        else:
            skin_r, skin_l = 0., max(0., z.imag / omega)
        relaxation_c = 2 * c * p["loss_tangent"]
        model = cls(p, l, c, dc, z.real, z.imag, skin_r, skin_l,
                    c * (1 - p["loss_tangent"]), relaxation_c,
                    1 / (omega * relaxation_c) if relaxation_c else 0.)
        if not all(math.isfinite(v) and v >= 0 for k, v in model.__dict__.items() if k != "parameters"):
            raise ValueError("同軸ケーブルの線路定数が計算可能範囲を超えています")
        return model

    def metadata(self) -> dict:
        p = self.parameters
        omega = 2 * math.pi * p["reference_frequency_hz"]
        z = complex(self.rf_resistance_ohm_m, omega * self.inductance_h_m + self.internal_reactance_ohm_m)
        y = omega * self.capacitance_f_m * complex(p["loss_tangent"], 1)
        gamma, impedance = cmath.sqrt(z * y), cmath.sqrt(z / y)
        phase = gamma.imag * p["length_m"] / p["segments"]
        return {"model": "passive TEM pi ladder with Foster conductor and Debye dielectric loss",
            "parameters": dict(p),
            "nominal_impedance_ohm": math.sqrt(self.inductance_h_m / self.capacitance_f_m),
            "tem_velocity_m_s": 1 / math.sqrt(self.inductance_h_m * self.capacitance_f_m),
            "tem_delay_s": p["length_m"] * math.sqrt(self.inductance_h_m * self.capacitance_f_m),
            **{k: v for k, v in self.__dict__.items() if k != "parameters"},
            "reference_impedance_real_ohm": impedance.real, "reference_impedance_imag_ohm": impedance.imag,
            "attenuation_db_m": 20 * gamma.real / math.log(10),
            "attenuation_db": 20 * gamma.real * p["length_m"] / math.log(10),
            "reference_phase_rad_m": gamma.imag, "section_phase_rad": phase,
            "warnings": ["基準周波数で1区間の位相が0.2 radを超えています。分割数を増やしてください。"] if phase > .2 else [],
            "assumptions": ["均一なTEM線路。シールド両端は共通の理想基準で外部コモンモードは含まない。",
                "中実円柱導体と平滑シールド。編組・撚線・めっき・粗さは含まない。",
                "DC抵抗と基準周波数の複素線路定数に合わせた受動損失近似。広帯域材料分散モデルではない。"]}


def _inner_impedance(radius, resistivity, omega, dc):
    if resistivity == 0:
        return 0j
    k = cmath.sqrt(1j * omega * MU0 / resistivity)
    x = k * radius
    if abs(x) < 1e-3:
        return complex(dc, omega * MU0 / (8 * math.pi))
    return resistivity * k * ive(0, x) / (2 * math.pi * radius * ive(1, x))


def _shield_impedance(radius, thickness, resistivity, omega, dc):
    if resistivity == 0:
        return 0j
    k = cmath.sqrt(1j * omega * MU0 / resistivity)
    effective_thickness = thickness * (1 + thickness / (2 * radius))
    x = k * effective_thickness
    if abs(x) < 1e-3:
        return complex(dc, omega * MU0 * effective_thickness / (6 * math.pi * radius))
    return resistivity * k / (2 * math.pi * radius * cmath.tanh(x))
