"""Pack only Qwen talker projections for CPU inference, one layer at a time.

This module deliberately has no Torch import at import time. The caller owns
model loading, inference threading and selection of the quantized CPU backend.
"""

_PROJECTION_NAMES = frozenset(
    ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")
)
_CPU_PROJECTION_TYPE = None


def _projection_type(torch):
    global _CPU_PROJECTION_TYPE
    if _CPU_PROJECTION_TYPE is None:
        class CpuProjection(torch.nn.Module):
            def __init__(self, packed, mode):
                super().__init__()
                self.packed = packed
                self.mode = mode

            def forward(self, value):
                # Dynamic packed Linear requires FP32 activations. The rest of
                # the voice model keeps its original (normally BF16) dtype.
                return self.packed(value.float()).to(dtype=value.dtype)

        _CPU_PROJECTION_TYPE = CpuProjection
    return _CPU_PROJECTION_TYPE


def prepare_cpu_projections(model, mode="fp16"):
    """Replace exact talker projection Linears with CPU inference wrappers.

    ``fp16`` keeps FP16 packed weights; ``int8`` uses per-channel dynamic INT8.
    The returned counts include wrappers already prepared in the same mode.
    Repeating a mode is safe; switching modes requires a freshly loaded model.
    Only names are collected before conversion, so original BF16 modules and
    their weights can be released as soon as each replacement is installed.
    """
    if mode not in ("fp16", "int8"):
        raise ValueError("CPU projection mode must be 'fp16' or 'int8'.")

    try:
        import torch
        from torch.ao.nn.quantized.dynamic import Linear as PackedLinear
        from torch.ao.quantization import (
            float16_dynamic_qconfig,
            per_channel_dynamic_qconfig,
        )
    except ImportError as error:
        raise RuntimeError("CPU projection packing requires PyTorch quantization support.") from error

    engine = torch.backends.quantized.engine
    if engine == "none" or engine not in torch.backends.quantized.supported_engines:
        raise RuntimeError("No quantized CPU backend is selected for voice projections.")
    if not isinstance(model, torch.nn.Module):
        raise TypeError("CPU projection packing requires a PyTorch model.")

    wrapper_type = _projection_type(torch)
    names = [
        name
        for name, module in model.named_modules()
        if name.startswith("talker.")
        and name.rsplit(".", 1)[-1] in _PROJECTION_NAMES
        and type(module) in (torch.nn.Linear, wrapper_type)
    ]
    if not names:
        raise RuntimeError("No supported talker projection layers were found.")

    # Preflight before replacing anything, including on repeated calls.
    for name in names:
        layer = model.get_submodule(name)
        if type(layer) is wrapper_type:
            if layer.mode != mode:
                raise RuntimeError("CPU projection mode cannot change without reloading the model.")
        elif layer.weight.device.type != "cpu" or (
            layer.bias is not None and layer.bias.device.type != "cpu"
        ):
            raise RuntimeError("Voice projections must be on CPU before packing.")
        del layer

    qconfig = float16_dynamic_qconfig if mode == "fp16" else per_channel_dynamic_qconfig
    converted = 0
    for name in names:
        layer = model.get_submodule(name)
        if type(layer) is wrapper_type:
            del layer
            continue

        try:
            # Meta construction avoids initializing an extra full FP32 matrix.
            # Only this projection's FP32 packing input exists at a time.
            temporary = torch.nn.Linear(
                layer.in_features,
                layer.out_features,
                bias=layer.bias is not None,
                device="meta",
                dtype=torch.float32,
            )
            temporary.weight = torch.nn.Parameter(layer.weight.detach().float(), requires_grad=False)
            if layer.bias is not None:
                temporary.bias = torch.nn.Parameter(layer.bias.detach().float(), requires_grad=False)
            temporary.qconfig = qconfig
            packed = PackedLinear.from_float(temporary)
            replacement = wrapper_type(packed, mode).train(layer.training)
            parent_name, child_name = name.rsplit(".", 1)
            setattr(model.get_submodule(parent_name), child_name, replacement)
        except (RuntimeError, NotImplementedError, AssertionError) as error:
            # Avoid leaking backend tracebacks or unbounded implementation text
            # into a UI error. The original exception remains available to logs.
            raise RuntimeError("CPU voice projection packing failed with the selected backend.") from error
        converted += 1
        del layer, temporary, packed, replacement

    return {"mode": mode, "count": len(names), "converted": converted}
