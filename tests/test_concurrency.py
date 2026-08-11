import anyio

from gvcsim import concurrency


def test_cpu_work_runs_in_worker_thread():
    async def exercise():
        return await concurrency.run_cpu_bound(lambda left, right: left + right, 2, 3)

    assert anyio.run(exercise) == 5
