"""CPU並列CICの競合・保存則・thread数独立性と元の演算との比較。"""
from __future__ import annotations

import numpy as np
import pytest

from es_sim.parallel import HAVE_NUMBA, ParticleKernels, environment_info
from es_sim.schema import Pic1dSettings, Project


@pytest.mark.skipif(not HAVE_NUMBA, reason="Numbaが利用できない環境")
def test_parallel_scatter_preserves_charge_without_races():
    # 全粒子が同じ2節点へ加算する配置は共有配列prangeの競合を露呈する。
    rng = np.random.default_rng(59)
    x = np.full(120_001, 0.00305)
    weights = rng.uniform(0.01, 100, len(x))
    parallel = ParticleKernels(True, 4)
    actual = parallel.deposit(x, weights, 0.0001, 101)
    assert actual.sum() == pytest.approx(weights.sum(), rel=3e-14)
    assert np.count_nonzero(actual) == 2
    for _ in range(3):
        np.testing.assert_array_equal(parallel.deposit(x, weights, 0.0001, 101), actual)


@pytest.mark.skipif(not HAVE_NUMBA, reason="Numbaが利用できない環境")
def test_parallel_scatter_is_thread_count_independent():
    rng = np.random.default_rng(23)
    x = rng.uniform(-0.002, 0.012, 40_001)
    weights = rng.normal(0, 10, len(x))
    a = ParticleKernels(True, 2).deposit(x, weights, 0.0001, 101)
    b = ParticleKernels(True, 4).deposit(x, weights, 0.0001, 101)
    np.testing.assert_array_equal(a, b)
    expected = ParticleKernels(False).deposit(x, weights, 0.0001, 101)
    np.testing.assert_allclose(a, expected, rtol=3e-13, atol=3e-12)


@pytest.mark.parametrize("n", [0, 3, 10_001])
def test_gather_and_push_match_original_numpy(n):
    rng = np.random.default_rng(42)
    x = rng.uniform(-0.002, 0.012, n)
    nodes = rng.normal(0, 1e4, 101)
    v_a = rng.normal(0, 1e5, (n, 3))
    v_b = v_a.copy()
    sequential, parallel = ParticleKernels(False), ParticleKernels(True, 4)
    np.testing.assert_array_equal(parallel.gather(nodes, x, 0.0001, 100),
                                  sequential.gather(nodes, x, 0.0001, 100))
    xa = sequential.push(x, v_a, nodes, 0.0001, 100, 1e-11, -1.7588e11)
    xb = parallel.push(x, v_b, nodes, 0.0001, 100, 1e-11, -1.7588e11)
    np.testing.assert_array_equal(xa, xb)
    np.testing.assert_array_equal(v_a, v_b)


def test_moments_conserve_particle_sums():
    rng = np.random.default_rng(51)
    x = rng.uniform(0, 0.01, 10_001)
    v = rng.normal(0, 1e5, (len(x), 3))
    w = rng.uniform(1, 10, len(x))
    kernels = ParticleKernels(True, 4)
    actual = kernels.moments(x, v, w, 0.0001, 101)
    expected = ParticleKernels(False).moments(x, v, w, 0.0001, 101)
    np.testing.assert_allclose(actual, expected, rtol=3e-12, atol=1e-7)
    sums = np.array([w.sum(), *((w * v[:, k]).sum() for k in range(3)),
                     *((w * v[:, k] ** 2).sum() for k in range(3))])
    np.testing.assert_allclose(actual.sum(axis=1), sums, rtol=3e-12)


def test_execution_defaults_and_thread_limit():
    s = Pic1dSettings(gap_m=0.01, init_density_m3=1e14)
    assert s.parallel is True
    assert s.cpu_threads is None
    k = ParticleKernels(True, 256)
    assert k.threads <= environment_info()["max_threads"]
    assert ParticleKernels(False, 256).threads == 1
    if not HAVE_NUMBA:
        assert not k.enabled
        assert k.metadata()["fallback_reason"]


@pytest.mark.skipif(not HAVE_NUMBA, reason="Numbaが利用できない環境")
def test_parallel_pic_matches_sequential_and_mcc_random_stream():
    from reference_cases import edupic_ar_processes
    from es_sim.pic1d import Pic1dSimulation

    electron, ion = edupic_ar_processes()
    common = dict(
        gap_m=0.025, n_cells=64, init_density_m3=1e14, n_macro=8_192,
        dt=1e-11, n_steps=40, frame_every=40, avg_steps=5,
        left={"v_dc": 30}, seed=18,
        mcc={"gas": {"pressure_pa": 20, "temperature_k": 300},
             "electron_processes": electron, "ion_processes": ion, "seed": 59},
    )
    seq = Pic1dSimulation(Project(pic1d=Pic1dSettings(**common, parallel=False)))
    par = Pic1dSimulation(Project(pic1d=Pic1dSettings(**common, parallel=True, cpu_threads=4)))
    seq.run_batch(store_frames=False)
    par.run_batch(store_frames=False)
    # RNGの抽選・イベント数は不変。場の加算順序に由来する丸め差のみ許容する。
    assert seq.coll_e == par.coll_e
    assert seq.ion_events == par.ion_events
    assert seq.mcc.rng.bit_generator.state == par.mcc.rng.bit_generator.state
    for name in seq.species:
        np.testing.assert_allclose(seq.species[name].x, par.species[name].x, rtol=2e-10, atol=2e-15)
        np.testing.assert_allclose(seq.species[name].v, par.species[name].v, rtol=2e-9, atol=1e-6)
        np.testing.assert_array_equal(seq.species[name].w, par.species[name].w)


@pytest.mark.skipif(not HAVE_NUMBA, reason="Numbaが利用できない環境")
def test_parallel_continuation_matches_uninterrupted_calculation():
    from es_sim.pic1d import Pic1dSimulation
    common = dict(gap_m=0.025, n_cells=64, init_density_m3=1e14, n_macro=8_192,
                  dt=1e-11, frame_every=40, avg_steps=5, seed=26, cpu_threads=4)
    uninterrupted = Pic1dSimulation(Project(pic1d=Pic1dSettings(**common, n_steps=40)))
    split = Pic1dSimulation(Project(pic1d=Pic1dSettings(**common, n_steps=20)))
    uninterrupted.run_batch(store_frames=False)
    split.run_batch(store_frames=False)
    split.prepare_continue(20, avg_steps=5)
    split.run_batch(store_frames=False)
    for name in split.species:
        np.testing.assert_array_equal(split.species[name].x, uninterrupted.species[name].x)
        np.testing.assert_array_equal(split.species[name].v, uninterrupted.species[name].v)


@pytest.mark.skipif(not HAVE_NUMBA, reason="Numbaが利用できない環境")
def test_parallel_simulation_does_not_depend_on_thread_count():
    from es_sim.pic1d import Pic1dSimulation
    common = dict(gap_m=0.025, n_cells=64, init_density_m3=1e14, n_macro=8_192,
                  dt=1e-11, frame_every=20, avg_steps=5, seed=29, n_steps=20)
    a = Pic1dSimulation(Project(pic1d=Pic1dSettings(**common, cpu_threads=2)))
    b = Pic1dSimulation(Project(pic1d=Pic1dSettings(**common, cpu_threads=4)))
    a.run_batch(store_frames=False)
    b.run_batch(store_frames=False)
    for name in a.species:
        np.testing.assert_array_equal(a.species[name].x, b.species[name].x)
        np.testing.assert_array_equal(a.species[name].v, b.species[name].v)
