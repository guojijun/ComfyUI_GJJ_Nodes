import numpy as np


def _weighted_linear_fit(x, y, weights):
    """Fit y ~= a*x + b with numpy only."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    weights = np.asarray(weights, dtype=np.float64)
    design = np.stack([x, np.ones_like(x)], axis=1)
    weighted_design = design * weights[:, None]
    weighted_y = y * weights
    try:
        solution, *_ = np.linalg.lstsq(weighted_design, weighted_y, rcond=None)
        return float(solution[0]), float(solution[1])
    except Exception:
        return 1.0, 0.0


def _solve_camera_params_numpy(three_d_points, focal_length, imshape, new_2d_points, *, y_weight=1.0):
    points = np.asarray(three_d_points, dtype=np.float64)
    targets = np.asarray(new_2d_points, dtype=np.float64)
    valid = np.isfinite(points).all(axis=1) & np.isfinite(targets).all(axis=1) & (np.abs(points[:, 2]) > 1e-6)
    points = points[valid]
    targets = targets[valid]
    if points.shape[0] == 0:
        return np.array([
            [focal_length, 0, imshape[1] / 2],
            [0, focal_length, imshape[0] / 2],
            [0, 0, 1],
        ]), 1.0, 1.0

    weights = np.ones(points.shape[0], dtype=np.float64)
    weights[0] = float(y_weight)
    x_proj = points[:, 0] / points[:, 2]
    y_proj = points[:, 1] / points[:, 2]
    x_target = targets[:, 0] - imshape[1] / 2
    y_target = targets[:, 1] - imshape[0] / 2

    fx_scale, p = _weighted_linear_fit(x_proj, x_target, weights)
    fy_scale, q = _weighted_linear_fit(y_proj, y_target, weights)
    if abs(focal_length) < 1e-6:
        m = 1.0
    else:
        m = float(np.clip(fx_scale / focal_length, 0.7, 1.4))
    if abs(fx_scale) < 1e-6:
        s = 1.0
    else:
        s = float(np.clip(fy_scale / max(abs(fx_scale), 1e-6), 0.8, 1.15))

    p = float(np.clip(p, -imshape[1], imshape[1]))
    q = float(np.clip(q, -imshape[0], imshape[0]))
    K_final = np.array([
        [focal_length * m, 0, imshape[1] / 2 + p],
        [0, focal_length * m * s, imshape[0] / 2 + q],
        [0, 0, 1],
    ])
    print(f"debug: solved camera params m={m}, s={s}, p={p}, q={q}")
    return K_final, m, s


def solve_new_camera_params_central(three_d_points, focal_length, imshape, new_2d_points):
    """
    Solve for new camera parameters by minimizing the error between the original 2D projection points and the new 2D projection points.

    Args:
        three_d_points (torch.Tensor): N*3 3D points
        focal_length (float): Focal length of the original camera
        imshape (tuple): Image size, e.g., [512, 896]
        original_2d_points (torch.Tensor): N*2 original 2D projection points
        new_2d_points (torch.Tensor): N*2 new 2D projection points

    Returns:
        m, n, p, q: Parameters in the new camera intrinsic matrix
    """


    return _solve_camera_params_numpy(three_d_points, focal_length, imshape, new_2d_points, y_weight=8.0)


def solve_new_camera_params_down(three_d_points, focal_length, imshape, new_2d_points):
    """
    Solve for new camera parameters by minimizing the error between the original 2D projection points and the new 2D projection points.

    Args:
        three_d_points (torch.Tensor): N*3 3D points
        focal_length (float): Focal length of the original camera
        imshape (tuple): Image size, e.g., [512, 896]
        original_2d_points (torch.Tensor): N*2 original 2D projection points
        new_2d_points (torch.Tensor): N*2 new 2D projection points

    Returns:
        m, n, p, q: Parameters in the new camera intrinsic matrix
    """

    return _solve_camera_params_numpy(three_d_points, focal_length, imshape, new_2d_points, y_weight=4.0)
