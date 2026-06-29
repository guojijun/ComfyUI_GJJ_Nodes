import logging
from typing import Callable, Iterable, Optional

import torch
try:
    from torchdiffeq import odeint
except Exception:
    odeint = None

# from torchcfm.conditional_flow_matching import ExactOptimalTransportConditionalFlowMatcher

log = logging.getLogger()
from comfy.utils import ProgressBar
from tqdm import tqdm

# Partially from https://github.com/gle-bellier/flow-matching
class FlowMatching:

    def __init__(self, min_sigma: float = 0.0, inference_mode='euler', num_steps: int = 25):
        # inference_mode: 'euler' or 'adaptive'
        # num_steps: number of steps in the euler inference mode
        super().__init__()
        self.min_sigma = min_sigma
        self.inference_mode = inference_mode
        self.num_steps = num_steps

        # self.fm = ExactOptimalTransportConditionalFlowMatcher(sigma=min_sigma)

        assert self.inference_mode in ['euler', 'adaptive']
        if self.inference_mode == 'adaptive' and num_steps > 0:
            log.info('The number of steps is ignored in adaptive inference mode ')

    def get_conditional_flow(self, x0: torch.Tensor, x1: torch.Tensor,
                             t: torch.Tensor) -> torch.Tensor:
        # which is psi_t(x), eq 22 in flow matching for generative models
        t = t[:, None, None].expand_as(x0)
        return (1 - (1 - self.min_sigma) * t) * x0 + t * x1

    def loss(self, predicted_v: torch.Tensor, x0: torch.Tensor, x1: torch.Tensor) -> torch.Tensor:
        # return the mean error without reducing the batch dimension
        reduce_dim = list(range(1, len(predicted_v.shape)))
        target_v = x1 - (1 - self.min_sigma) * x0
        return (predicted_v - target_v).pow(2).mean(dim=reduce_dim)

    def get_x0_xt_c(
        self,
        x1: torch.Tensor,
        t: torch.Tensor,
        Cs: list[torch.Tensor],
        generator: Optional[torch.Generator] = None
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        # x0 = torch.randn_like(x1, generator=generator)
        x0 = torch.empty_like(x1).normal_(generator=generator)

        # find mini-batch optimal transport
        # x0, x1, _, Cs = self.fm.ot_sampler.sample_plan_with_labels(x0, x1, None, Cs, replace=True)

        xt = self.get_conditional_flow(x0, x1, t)
        return x0, x1, xt, Cs

    def to_prior(self, fn: Callable, x1: torch.Tensor) -> torch.Tensor:
        return self.run_t0_to_t1(fn, x1, 1, 0)

    def to_data(self, fn: Callable, x0: torch.Tensor) -> torch.Tensor:
        return self.run_t0_to_t1(fn, x0, 0, 1)

    def run_t0_to_t1(self, fn: Callable, x0: torch.Tensor, t0: float, t1: float) -> torch.Tensor:
        # fn: a function that takes (t, x) and returns the direction x0->x1

        if self.inference_mode == 'adaptive':
            if odeint is not None:
                return odeint(fn, x0, torch.tensor([t0, t1], device=x0.device, dtype=x0.dtype))
            log.warning('torchdiffeq is not installed; using built-in Euler fallback for adaptive mode.')
            fallback_steps = max(1, int(self.num_steps or 25))
            x = x0
            steps = torch.linspace(t0, t1 - self.min_sigma, fallback_steps + 1, device=x0.device, dtype=x0.dtype)
            for ti, t in enumerate(steps[:-1]):
                flow = fn(t, x)
                next_t = steps[ti + 1]
                x = x + (next_t - t) * flow
            return torch.stack((x0, x), dim=0)
        elif self.inference_mode == 'euler':
            x = x0
            steps = torch.linspace(t0, t1 - self.min_sigma, self.num_steps + 1, device=x0.device, dtype=x0.dtype)
            comfy_pbar = ProgressBar(len(steps)-1)
            tqdm_pbar = tqdm(total=len(steps) -1, desc='Flow Matching')
            for ti, t in enumerate(steps[:-1]):
                flow = fn(t, x)
                next_t = steps[ti + 1]
                dt = next_t - t
                x = x + dt * flow
                comfy_pbar.update(1)
                tqdm_pbar.update(1)

            # return odeint(fn,
            #               x0,
            #               torch.tensor([t0, t1], device=x0.device, dtype=x0.dtype),
            #               method='rk4',
            #               options=dict(step_size=(t1 - t0) / self.num_steps))[-1]
            # return odeint(fn,
            #               x0,
            #               torch.tensor([t0, t1], device=x0.device, dtype=x0.dtype),
            #               method='euler',
            #               options=dict(step_size=(t1 - t0) / self.num_steps))[-1]

        return x
