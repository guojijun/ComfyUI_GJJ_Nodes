import base64
import io as pyio
import logging
import queue
import threading
import time

import numpy as np
import torch

import comfy.model_management
import comfy.patcher_extension
import latent_preview
from PIL import Image, ImageOps

class _LTXWrappedPreviewer:
    """Small self-contained LTX preview decoder used by this node only."""

    def __init__(self, latent_rgb_factors, latent_rgb_factors_bias, rate=8, taeltx=None):
        self.taeltx = taeltx
        self.rate = rate
        self.latent_rgb_factors = torch.tensor(
            latent_rgb_factors, device="cpu"
        ).transpose(0, 1)
        self.latent_rgb_factors_bias = (
            torch.tensor(latent_rgb_factors_bias, device="cpu")
            if latent_rgb_factors_bias is not None
            else None
        )

    def decode_latent_to_preview(self, x0):
        if self.taeltx is not None:
            decoder = self.taeltx.first_stage_model.decoder
            x0 = x0.unsqueeze(0).to(
                dtype=decoder[1].weight.dtype,
                device=comfy.model_management.get_torch_device(),
            )
            return self.taeltx.first_stage_model.decode(x0)[0].permute(1, 2, 3, 0)

        factors = self.latent_rgb_factors.to(dtype=x0.dtype, device=x0.device)
        bias = self.latent_rgb_factors_bias
        if bias is not None:
            bias = bias.to(dtype=x0.dtype, device=x0.device)
        latent_image = torch.nn.functional.linear(
            x0.movedim(1, -1), factors, bias=bias
        )
        return torch.sigmoid(latent_image)


def _get_ltx_rgb_factors_impl(is_23):
    if not is_23:
        latent_rgb_factors = [
                [ 0.0350,  0.0159,  0.0132],
                [ 0.0025, -0.0021, -0.0003],
                [ 0.0286,  0.0028,  0.0020],
                [ 0.0280, -0.0114, -0.0202],
                [-0.0186,  0.0073,  0.0092],
                [ 0.0027,  0.0097, -0.0113],
                [-0.0069, -0.0032, -0.0024],
                [-0.0323, -0.0370, -0.0457],
                [ 0.0174,  0.0164,  0.0106],
                [-0.0097,  0.0061,  0.0035],
                [-0.0130, -0.0042, -0.0012],
                [-0.0102, -0.0002, -0.0091],
                [-0.0025,  0.0063,  0.0161],
                [ 0.0003,  0.0037,  0.0108],
                [ 0.0152,  0.0082,  0.0143],
                [ 0.0317,  0.0203,  0.0312],
                [-0.0092, -0.0233, -0.0119],
                [-0.0405, -0.0226, -0.0023],
                [ 0.0376,  0.0397,  0.0352],
                [ 0.0171, -0.0043, -0.0095],
                [ 0.0482,  0.0341,  0.0213],
                [ 0.0031, -0.0046, -0.0018],
                [-0.0486, -0.0383, -0.0294],
                [-0.0071, -0.0272, -0.0123],
                [ 0.0320,  0.0218,  0.0289],
                [ 0.0327,  0.0088, -0.0116],
                [-0.0098, -0.0240, -0.0111],
                [ 0.0094, -0.0116,  0.0021],
                [ 0.0309,  0.0092,  0.0165],
                [-0.0065, -0.0077, -0.0107],
                [ 0.0179,  0.0114,  0.0038],
                [-0.0018, -0.0030, -0.0026],
                [-0.0002,  0.0076, -0.0029],
                [-0.0131, -0.0059, -0.0170],
                [ 0.0055,  0.0066, -0.0038],
                [ 0.0154,  0.0063,  0.0090],
                [ 0.0186,  0.0175,  0.0188],
                [-0.0166, -0.0381, -0.0428],
                [ 0.0121,  0.0015, -0.0153],
                [ 0.0118,  0.0050,  0.0019],
                [ 0.0125,  0.0259,  0.0231],
                [ 0.0046,  0.0130,  0.0081],
                [ 0.0271,  0.0250,  0.0250],
                [-0.0054, -0.0347, -0.0326],
                [-0.0438, -0.0262, -0.0228],
                [-0.0191, -0.0256, -0.0173],
                [-0.0205, -0.0058,  0.0042],
                [ 0.0404,  0.0434,  0.0346],
                [-0.0242, -0.0177, -0.0146],
                [ 0.0161,  0.0223,  0.0168],
                [-0.0240, -0.0320, -0.0299],
                [-0.0019,  0.0043,  0.0008],
                [-0.0060, -0.0133, -0.0244],
                [-0.0048, -0.0225, -0.0167],
                [ 0.0267,  0.0133,  0.0152],
                [ 0.0222,  0.0167,  0.0028],
                [ 0.0015, -0.0062,  0.0013],
                [-0.0241, -0.0178, -0.0079],
                [ 0.0040, -0.0081, -0.0097],
                [-0.0064,  0.0133, -0.0011],
                [-0.0204, -0.0231, -0.0304],
                [ 0.0011, -0.0011,  0.0145],
                [-0.0283, -0.0259, -0.0260],
                [ 0.0038,  0.0171, -0.0029],
                [ 0.0637,  0.0424,  0.0409],
                [ 0.0092,  0.0163,  0.0188],
                [ 0.0082,  0.0055, -0.0179],
                [-0.0177, -0.0286, -0.0147],
                [ 0.0171,  0.0242,  0.0398],
                [-0.0129,  0.0095, -0.0071],
                [-0.0154,  0.0036,  0.0128],
                [-0.0081, -0.0009,  0.0118],
                [-0.0067, -0.0178, -0.0230],
                [-0.0022, -0.0125, -0.0003],
                [-0.0032, -0.0039, -0.0022],
                [-0.0005, -0.0127, -0.0131],
                [-0.0143, -0.0157, -0.0165],
                [-0.0262, -0.0263, -0.0270],
                [ 0.0063,  0.0127,  0.0178],
                [ 0.0092,  0.0133,  0.0150],
                [-0.0106, -0.0068,  0.0032],
                [-0.0214, -0.0022,  0.0171],
                [-0.0104, -0.0266, -0.0362],
                [ 0.0021,  0.0048, -0.0005],
                [ 0.0345,  0.0431,  0.0402],
                [-0.0275, -0.0110, -0.0195],
                [ 0.0203,  0.0251,  0.0224],
                [ 0.0016, -0.0037, -0.0094],
                [ 0.0241,  0.0198,  0.0114],
                [-0.0003,  0.0027,  0.0141],
                [ 0.0012, -0.0052, -0.0084],
                [ 0.0057, -0.0028, -0.0163],
                [-0.0488, -0.0545, -0.0509],
                [-0.0076, -0.0025, -0.0014],
                [-0.0249, -0.0142, -0.0367],
                [ 0.0136,  0.0041,  0.0135],
                [ 0.0007,  0.0034, -0.0053],
                [-0.0068, -0.0109,  0.0029],
                [ 0.0006, -0.0237, -0.0094],
                [-0.0149, -0.0177, -0.0131],
                [-0.0105,  0.0039,  0.0216],
                [ 0.0242,  0.0200,  0.0180],
                [-0.0339, -0.0153, -0.0195],
                [ 0.0104,  0.0151,  0.0120],
                [-0.0043,  0.0089,  0.0047],
                [ 0.0157, -0.0030,  0.0008],
                [ 0.0126,  0.0102, -0.0040],
                [ 0.0040,  0.0114,  0.0137],
                [ 0.0423,  0.0473,  0.0436],
                [-0.0128, -0.0066, -0.0152],
                [-0.0337, -0.0087, -0.0026],
                [-0.0052,  0.0235,  0.0291],
                [ 0.0079,  0.0154,  0.0260],
                [-0.0539, -0.0377, -0.0358],
                [-0.0188,  0.0062, -0.0035],
                [-0.0186,  0.0041, -0.0083],
                [ 0.0045, -0.0049,  0.0053],
                [ 0.0172,  0.0071,  0.0042],
                [-0.0003, -0.0078, -0.0096],
                [-0.0209, -0.0132, -0.0135],
                [-0.0074,  0.0017,  0.0099],
                [-0.0038,  0.0070,  0.0014],
                [-0.0013, -0.0017,  0.0073],
                [ 0.0030,  0.0105,  0.0105],
                [ 0.0154, -0.0168, -0.0235],
                [-0.0108, -0.0038,  0.0047],
                [-0.0298, -0.0347, -0.0436],
                [-0.0206, -0.0189, -0.0139]
            ]
        latent_rgb_factors_bias = [0.2796, 0.1101, -0.0047]
    else:
        latent_rgb_factors = [[0.002269406570121646, -0.02110900916159153, -0.009850316680967808], [-0.016038373112678528, -0.012462412007153034, -0.01112896017730236], [0.025274179875850677, 0.011209743097424507, 0.025426799431443214], [0.04690725728869438, 0.041542328894138336, 0.03568895906209946], [-0.02388044260442257, -0.0018645941745489836, 0.01858334057033062], [0.03720448538661003, 0.0220357533544302, 0.027937663719058037], [-0.07273884862661362, -0.09326262027025223, -0.11579664051532745], [-0.063837431371212, 0.00026216846890747547, 0.03042735904455185], [0.02903873845934868, 0.042082373052835464, 0.030649805441498756], [0.03777873516082764, 0.0322984978556633, -0.005671461578458548], [-0.0075670829974114895, -0.012113905511796474, -0.01638956367969513], [0.026524530723690987, 0.060518112033605576, 0.059549521654844284], [0.10093028098344803, 0.10073262453079224, 0.0505094900727272], [0.03725508227944374, 0.015382086858153343, 0.005786076188087463], [-0.03139607608318329, -0.01690264232456684, -0.0013519978383556008], [-0.027200624346733093, -0.02517341822385788, -0.008874989114701748], [0.024963486939668655, 0.04293748363852501, 0.05582639202475548], [-0.0364827960729599, -0.026975594460964203, -0.021950015798211098], [0.027655167505145073, 0.025136707350611687, 0.043967027217149734], [0.035822272300720215, 0.013104500249028206, 0.01113432738929987], [0.05353763327002525, 0.013606574386358261, -0.018720127642154694], [-0.013587888330221176, -0.01689346879720688, -0.027842802926898003], [0.059415675699710846, 0.03734271228313446, 0.04562298208475113], [-0.02946414425969124, -0.038338612765073776, 0.001805233070626855], [0.03921474143862724, 0.0651894062757492, 0.10681862384080887], [-0.00744189927354455, 0.007951526902616024, 0.020728807896375656], [-0.04038553684949875, -0.05215264856815338, -0.07213657349348068], [-0.004655141849070787, 0.01305423304438591, 0.026104029268026352], [0.03434251993894577, 0.018448110669851303, 0.013096392154693604], [0.0022075253073126078, -0.0011812079465016723, 0.0002940484555438161], [-0.00043441299931146204, 0.02366728149354458, 0.035889431834220886], [-0.030657343566417694, -0.024926183745265007, -0.012355240061879158], [-0.018955843523144722, -0.017360301688313484, -0.008214764297008514], [-0.01113052573055029, -0.01201171800494194, -0.002986249281093478], [0.018902746960520744, 0.01758778840303421, 0.026414571329951286], [-0.019977254793047905, -0.01605399139225483, -0.019136475399136543], [-0.00300968368537724, -0.017609693109989166, -0.013655650429427624], [0.0022096361499279737, 0.017998533323407173, 0.01815750263631344], [0.05186990648508072, 0.03285299986600876, 0.016072165220975876], [0.012626334093511105, 0.0013884707586839795, -0.012077193707227707], [-0.0037861645687371492, -0.013902144506573677, -0.01911942847073078], [-0.014163163490593433, -0.00513274222612381, -0.014303527772426605], [-0.010461323894560337, 0.009658926166594028, 0.01644069515168667], [-0.008665377274155617, 0.002501955023035407, -0.009703717194497585], [-0.03404829278588295, -0.02546044997870922, -0.014914450235664845], [0.04997691139578819, 0.06592527031898499, 0.073111392557621], [0.027394814416766167, 0.024555068463087082, 0.019957970827817917], [-0.027501430362462997, -0.01673700101673603, -0.03089248389005661], [-0.018696032464504242, -0.0020940247923135757, 0.015244065783917904], [-0.0062704551964998245, -0.0067006442695856094, -0.007532030809670687], [0.014871004968881607, 0.009914354421198368, 0.020960720255970955], [0.03662937879562378, 0.04413224756717682, 0.04220828413963318], [-0.011242181062698364, -0.013539309613406658, -0.016438307240605354], [-0.014854325912892818, 0.0038217694964259863, -0.002461288822814822], [-0.014826249331235886, 0.0009719038498587906, -0.012078499421477318], [-0.029396841302514076, -0.01432017982006073, 0.013018904253840446], [0.02755064144730568, 0.028369395062327385, 0.01640605367720127], [0.12049165368080139, 0.1395745575428009, 0.14566579461097717], [0.019721267744898796, 0.009739740751683712, 0.0023876908235251904], [-0.007320966571569443, 0.0065013207495212555, 0.01603059470653534], [0.007391378283500671, -0.0073603675700724125, -0.01770283281803131], [0.02984853833913803, 0.012391146272420883, 0.010563627816736698], [-0.013479884713888168, -0.008637298829853535, -0.013457189314067364], [0.04127075523138046, 0.03032625839114189, 0.024770958349108696], [-0.06524652987718582, -0.012209279462695122, 0.02087211236357689], [-0.1179763451218605, -0.060323599725961685, -0.07592175155878067], [-0.07122819870710373, -0.04385707899928093, -0.022124603390693665], [-0.04682473465800285, -0.022610662505030632, -0.010107148438692093], [-0.0054328180849552155, -0.010368981398642063, -0.008167334832251072], [0.029181398451328278, 0.030588403344154358, 0.028090540319681168], [0.016619984060525894, 0.004931286443024874, -0.006450849585235119], [0.01035264041274786, 0.002237115055322647, 0.0013903985964134336], [-0.04313831403851509, -0.061772625893354416, -0.08946335315704346], [0.0150345079600811, 0.007781678810715675, 0.0011013159528374672], [-0.013585779815912247, 0.008117705583572388, 0.020367907360196114], [-0.172962948679924, -0.16406646370887756, -0.1668281853199005], [0.0083833709359169, 0.0015236001927405596, -0.01731627807021141], [0.021939430385828018, 0.018004458397626877, 0.014768349006772041], [0.008083095774054527, -0.013463049195706844, -0.022061636671423912], [0.024328550323843956, 0.0128010343760252, 0.014966367743909359], [0.05850301682949066, 0.027980001643300056, 0.02225641906261444], [0.09690416604280472, 0.06929530203342438, 0.03253814950585365], [0.048208240419626236, 0.025294817984104156, 0.023508133366703987], [-0.026432134211063385, -0.040383171290159225, -0.03950457274913788], [-0.021598653867840767, -0.017070941627025604, -0.010933087207376957], [0.011645167134702206, 0.002806191798299551, 0.003779367310926318], [0.10478592664003372, 0.08954174816608429, 0.06555330753326416], [0.015151776373386383, -0.016160616651177406, -0.024905217811465263], [0.019659176468849182, 0.008487952873110771, 0.002426224760711193], [-0.05173315480351448, -0.026337839663028717, -0.02127116546034813], [0.016987523064017296, 0.006270893849432468, 0.0015798212261870503], [0.007938026450574398, -0.005250005517154932, -0.020408453419804573], [0.013017759658396244, 0.01654384844005108, 0.04163840040564537], [-0.009886542335152626, -0.026848411187529564, -0.03070281818509102], [0.01108171883970499, 0.01827266439795494, -0.007332107983529568], [-0.0285995751619339, -0.031727731227874756, -0.03370537981390953], [0.005299570970237255, 0.05678633600473404, 0.02825017087161541], [-0.055322226136922836, -0.09084303677082062, -0.12999044358730316], [0.01844066195189953, 0.031044499948620796, 0.021148500964045525], [-0.004471115302294493, 0.005830412730574608, 0.00911418441683054], [-0.04053843766450882, -0.016424428671598434, -0.0010634599020704627], [0.03858831524848938, 0.007309338077902794, -0.005618985276669264], [0.01423253770917654, -0.0055681923404335976, 3.394074519746937e-05], [0.11455483734607697, 0.14653916656970978, 0.1488018035888672], [-0.005231931805610657, -0.0033921014983206987, -0.000995257287286222], [0.01449565589427948, 0.019586293026804924, 0.04565812274813652], [-0.005179048050194979, -0.011201606132090092, -0.0008710073889233172], [-0.015361929312348366, 0.00778581015765667, -0.008238887414336205], [-0.1147838830947876, -0.09109023958444595, -0.050579313188791275], [0.09037500619888306, 0.09597006440162659, 0.10811734944581985], [0.001873677596449852, -0.01772197335958481, -0.07681205868721008], [-0.020383257418870926, -0.016072455793619156, -0.01077069528400898], [-0.060444317758083344, -0.05499502643942833, -0.06153025105595589], [-0.016717270016670227, 0.026493264362215996, 0.021835654973983765], [0.008203534409403801, 0.00418612826615572, 0.013867748901247978], [0.0789225772023201, 0.05467747151851654, 0.016568133607506752], [-0.15149451792240143, -0.1526806503534317, -0.14325062930583954], [0.00538366474211216, 0.010192245244979858, -0.00449327751994133], [-0.004906965419650078, -0.005569908302277327, -0.02096559666097164], [0.024530155584216118, 0.010962833650410175, 0.0034586559049785137], [0.03551010414958, 0.017310436815023422, 0.007064413744956255], [0.11111932247877121, 0.09825586527585983, 0.08827318251132965], [-0.051722846925258636, -0.047595202922821045, -0.03763044252991676], [-0.02975175902247429, -0.02153967320919037, -0.021425534039735794], [-0.03462936729192734, -0.025198571383953094, -0.017322326079010963], [-0.016921017318964005, -0.012419789098203182, -0.0154880927875638], [-0.08035065978765488, -0.08451078832149506, -0.09623870998620987], [-0.03870908170938492, -0.04211008921265602, -0.04383759945631027]]
        latent_rgb_factors_bias = [-0.6957847476005554, -0.7276281118392944, -0.7405748963356018]
    return latent_rgb_factors, latent_rgb_factors_bias


_ltx_rgb_factors = _get_ltx_rgb_factors_impl


try:
    from server import PromptServer
except ImportError:
    PromptServer = None

def _suppressed_preview_image(self_, preview_format, x0):
    return None


class _AsyncPreviewEncoder:
    """Off-thread encoder. Bounded FIFO drops-on-full so the sampler never blocks on us."""

    _STOP = object()

    def __init__(self, max_in_flight=2):
        self.q = queue.Queue(maxsize=max_in_flight)
        self.thread = threading.Thread(target=self._run, name="kj_preview_encoder", daemon=True)
        self.thread.start()

    def submit(self, fn):
        try:
            self.q.put_nowait(fn)
            return True
        except queue.Full:
            return False

    def _run(self):
        while True:
            item = self.q.get()
            if item is self._STOP:
                return
            try:
                item()
            except Exception:
                logging.exception("[GJJ ModelPreviewOverride] async encoder error")

    def shutdown(self, drain_timeout=5.0):
        try:
            self.q.put(self._STOP, timeout=drain_timeout)
        except queue.Full:
            pass
        self.thread.join(timeout=drain_timeout)


def _get_core_previewer(load_device, latent_format):
    # Walk past custom-node hooks on get_previewer to reach the unwrapped core function.
    fn = latent_preview.get_previewer
    seen = set()
    while hasattr(fn, "__wrapped__") and id(fn) not in seen:
        seen.add(id(fn))
        fn = fn.__wrapped__
    return fn(load_device, latent_format)


def _decode_video_frames_l2rgb(x0, latent_format, max_frames, stride=1):
    # Bulk-blocking GPU→CPU copy (not per-frame non_blocking) avoids torn frames at high res.
    if x0.ndim != 5:
        return []
    rgb_factors = getattr(latent_format, "latent_rgb_factors", None)
    if rgb_factors is None:
        return []
    try:
        reshape = getattr(latent_format, "latent_rgb_factors_reshape", None)
        if reshape is not None:
            x0 = reshape(x0)
        bias = getattr(latent_format, "latent_rgb_factors_bias", None)
        factors = torch.tensor(rgb_factors, device=x0.device, dtype=x0.dtype).transpose(0, 1)
        bias_t = torch.tensor(bias, device=x0.device, dtype=x0.dtype) if bias is not None else None
        x = x0[0]
        if stride > 1:
            x = x[:, ::stride]
        t_total = x.shape[1]
        if max_frames > 0 and max_frames < t_total:
            indices = np.linspace(0, t_total - 1, max_frames).round().astype(int).tolist()
            x = x[:, indices]
        x = x.movedim(0, -1)
        rgb = torch.nn.functional.linear(x, factors, bias=bias_t)
        rgb.add_(1.0).mul_(127.5).clamp_(0, 255)
        rgb_cpu = rgb.to(torch.uint8).cpu().numpy()
        return [Image.fromarray(rgb_cpu[i]) for i in range(rgb_cpu.shape[0])]
    except Exception:
        return []


# PyPI PyAV wheels typically lack NVENC; probe once at import.
def _probe_nvenc():
    try:
        import av  # noqa
        av.Codec("h264_nvenc", "w")
        return True
    except Exception:
        return False

_NVENC_AVAILABLE = _probe_nvenc()

# NVENC H.264 rejects sub-145×49 inputs at avcodec_open2 — fall back to WebP for small frames.
_NVENC_MIN_W = 145
_NVENC_MIN_H = 49

_nvenc_warned = False


def _encode_mp4_nvenc(frames, fps, max_res):
    # Fragmented MP4 so the browser can decode mid-download. Returns (None, 0, 0) on failure
    # (including too-small-for-NVENC), so caller falls through to WebP.
    global _nvenc_warned
    if not frames:
        return None, 0, 0
    try:
        import av
    except Exception:
        return None, 0, 0
    pil_frames = []
    for f in frames:
        pf = f if f.mode == "RGB" else f.convert("RGB")
        if max_res and max_res > 0 and (pf.width > max_res or pf.height > max_res):
            pf = ImageOps.contain(pf, (max_res, max_res), Image.LANCZOS)
        pil_frames.append(pf)
    # yuv420p requires even dimensions.
    w0, h0 = pil_frames[0].width, pil_frames[0].height
    out_w, out_h = w0 & ~1, h0 & ~1
    if (out_w, out_h) != (w0, h0):
        pil_frames = [pf.resize((out_w, out_h), Image.LANCZOS) for pf in pil_frames]
    if out_w < _NVENC_MIN_W or out_h < _NVENC_MIN_H:
        return None, 0, 0
    # Driver/GPU varies what option combos are accepted; bare preset always works.
    option_candidates = [
        {"preset": "p1", "rc": "vbr", "cq": "23"},
        {"preset": "p1"},
    ]
    last_err = None
    for opts in option_candidates:
        buf = pyio.BytesIO()
        try:
            container = av.open(
                buf, mode="w", format="mp4",
                options={"movflags": "frag_keyframe+empty_moov+default_base_moof"},
            )
            stream = container.add_stream("h264_nvenc", rate=int(max(1, fps)))
            stream.width = out_w
            stream.height = out_h
            stream.pix_fmt = "yuv420p"
            stream.options = opts
            for pf in pil_frames:
                for pkt in stream.encode(av.VideoFrame.from_image(pf)):
                    container.mux(pkt)
            for pkt in stream.encode():
                container.mux(pkt)
            container.close()
            return base64.b64encode(buf.getvalue()).decode("ascii"), out_w, out_h
        except Exception as e:
            last_err = e
            continue
    if not _nvenc_warned:
        _nvenc_warned = True
        logging.warning(f"[GJJ ModelPreviewOverride] NVENC MP4 encode failed, using WebP fallback: {last_err}")
    return None, 0, 0


def _encode_animated_webp(frames, fps, quality, max_res):
    if not frames:
        return None, 0, 0
    pil_frames = []
    for f in frames:
        pf = f
        if pf.mode != "RGB":
            pf = pf.convert("RGB")
        if max_res and max_res > 0 and (pf.width > max_res or pf.height > max_res):
            pf = ImageOps.contain(pf, (max_res, max_res), Image.LANCZOS)
        pil_frames.append(pf)
    duration_ms = max(1, int(round(1000 / max(1, fps))))
    buf = pyio.BytesIO()
    try:
        pil_frames[0].save(
            buf,
            format="WEBP",
            save_all=True,
            append_images=pil_frames[1:],
            duration=duration_ms,
            loop=0,
            quality=quality,
            method=4,
        )
    except Exception as e:
        logging.warning(f"Animated WebP encode failed: {e}")
        return None, 0, 0
    return base64.b64encode(buf.getvalue()).decode("ascii"), pil_frames[0].width, pil_frames[0].height


def _interp_db_curve(t, xs, ys):
    # Mirrors sampler_nodes._interp_curve.
    if t <= xs[0]:
        return ys[0]
    if t >= xs[-1]:
        return ys[-1]
    for i in range(len(xs) - 1):
        if xs[i] <= t <= xs[i + 1]:
            span = xs[i + 1] - xs[i]
            if span <= 0:
                return ys[i]
            f = (t - xs[i]) / span
            return ys[i] + f * (ys[i + 1] - ys[i])
    return 0.0


def _detect_detail_boost_curve(sampler, model_patcher, sigmas_list):
    # Amount is already baked into ys by the editor, so peak ys == user-set amount.
    try:
        extra = getattr(sampler, "extra_options", None) or {}
        xs = extra.get("db_curve_xs")
        ys = extra.get("db_curve_ys")
        if "db_wrapped_sampler" not in extra or not xs or not ys or len(xs) != len(ys) or len(xs) < 2:
            return None
        ms = model_patcher.get_model_object("model_sampling")
        start_sigma = float(ms.percent_to_sigma(extra.get("db_start_percent", 0.0)))
        end_sigma = float(ms.percent_to_sigma(extra.get("db_end_percent", 1.0)))
        # None outside the gate so JS can distinguish "inactive" from "active with value 0".
        out = []
        for s in sigmas_list:
            sig = float(s)
            if sig <= 0 or start_sigma <= end_sigma or sig >= start_sigma or sig <= end_sigma:
                out.append(None)
                continue
            t = (start_sigma - sig) / (start_sigma - end_sigma)
            out.append(_interp_db_curve(t, xs, ys))
        return out
    except Exception as e:
        logging.warning(f"[GJJ ModelPreviewOverride] DB curve detection failed: {e}")
        return None


def _ltx_decode_to_pil(ltx_previewer, x0_5d, max_frames=None, stride=1):
    # Pre-shape (B, C, T, H, W) → (B*T, C, H, W); WrappedPreviewer adds the sequence-batch dim.
    if ltx_previewer is None or x0_5d.ndim != 5:
        return []
    if stride > 1:
        x0_5d = x0_5d[:, :, ::stride]
    x_moved = x0_5d.movedim(2, 1)  # (B, T, C, H, W) — must take shape AFTER movedim
    x_in = x_moved.reshape((-1,) + x_moved.shape[-3:])
    rgb = ltx_previewer.decode_latent_to_preview(x_in)
    if rgb is None:
        return []
    if rgb.ndim == 3:
        rgb = rgb.unsqueeze(0)
    if rgb.ndim != 4:
        return []
    t_total = rgb.shape[0]
    if max_frames is not None and 0 < max_frames < t_total:
        indices = np.linspace(0, t_total - 1, max_frames).round().astype(int).tolist()
        rgb = rgb[indices]
    u8 = (rgb * 255).clamp(0, 255).to(torch.uint8).cpu().numpy()
    return [Image.fromarray(u8[i]) for i in range(u8.shape[0])]


def _ltx_full_vae_decode_to_pil(vae, x0_5d, max_frames=None, stride=1):
    # vae.decode handles device + tiling. Slow vs TAEHV but full quality. Output shape
    # varies by VAE; we accept (B, T, H, W, C) or (T, H, W, C) and normalize.
    if vae is None or x0_5d.ndim != 5:
        return []
    if stride > 1:
        x0_5d = x0_5d[:, :, ::stride]
    try:
        images = vae.decode(x0_5d)
    except Exception as e:
        logging.warning(f"[GJJ ModelPreviewOverride] LTX VAE decode failed: {e}")
        return []
    if images.ndim == 5:
        images = images[0]
    if images.ndim != 4:
        return []
    t_total = images.shape[0]
    if max_frames is not None and 0 < max_frames < t_total:
        indices = np.linspace(0, t_total - 1, max_frames).round().astype(int).tolist()
        images = images[indices]
    u8 = (images.float() * 255).clamp(0, 255).to(torch.uint8).cpu().numpy()
    return [Image.fromarray(u8[i]) for i in range(u8.shape[0])]


def _is_ltx_latent_format(latent_format):
    return "LTX" in type(latent_format).__name__


def _is_ltx2_diffusion_model(model_patcher):
    # Same probe as ltxv_nodes.OuterSampleCallbackWrapper.
    try:
        dm = model_patcher.model.diffusion_model
        return not getattr(dm, "caption_projection_first_linear", True)
    except Exception:
        return False


def _ltx_num_keyframes(guider):
    try:
        positive = guider.conds.get("positive") if hasattr(guider, "conds") else None
        if positive and len(positive) > 0:
            kf = positive[0].get("keyframe_idxs")
            if kf is not None:
                return int(torch.unique(kf[0, 0, :, 0]).numel())
    except Exception:
        pass
    return 0


def _normalize_ltx_x0(x0, latent_shapes, num_keyframes):
    # LTX flattens spatial+temporal into a token sequence and may append keyframe latents
    # at the tail. Restore 5D and trim so downstream previewers see standard video latents.
    if latent_shapes and len(latent_shapes) > 0:
        target = latent_shapes[0]
        if x0.ndim == 3 and len(target) >= 3:
            cut = 1
            for d in target[1:]:
                cut *= int(d)
            x0 = x0[:, :, :cut].reshape([x0.shape[0]] + list(target)[1:])
    if num_keyframes > 0 and x0.ndim == 5:
        x0 = x0[:, :, :-num_keyframes]
    return x0


class _PreviewOverrideWrapper:
    def __init__(self, max_resolution, node_id, jpeg_quality, suppress_default, preview_frames=1, preview_fps=12, vae=None):
        self.max_resolution = max_resolution
        self.node_id = str(node_id) if node_id is not None else None
        self.jpeg_quality = jpeg_quality
        self.suppress_default = suppress_default
        self.preview_frames = preview_frames
        self.preview_fps = preview_fps
        self.vae = vae

    def __call__(self, executor, noise, latent_image, sampler, sigmas, denoise_mask, callback, disable_pbar, seed, latent_shapes):
        guider = executor.class_obj
        model_patcher = guider.model_patcher

        is_ltx = _is_ltx_latent_format(model_patcher.model.latent_format)
        is_ltx2 = is_ltx and _is_ltx2_diffusion_model(model_patcher)
        num_keyframes = _ltx_num_keyframes(guider) if is_ltx else 0

        # LTX reuses the LTX-specific node's WrappedPreviewer; we call decode_latent_to_preview
        # directly per step, bypassing its decode_latent_to_preview_image rate-limiting.
        # If a non-TAEHV VAE is supplied, decode via vae.decode() for full quality (slower).
        ltx_previewer = None
        ltx_full_vae = None
        vae_restore_device = None
        if is_ltx:
            try:
                factors, bias = _ltx_rgb_factors(is_ltx2)
                taeltx = None
                if self.vae is not None:
                    if self.vae.first_stage_model.__class__.__name__ == "TAEHV":
                        # TAEHV-LTX decode needs the VAE on GPU; restored at end of __call__.
                        target_device = comfy.model_management.get_torch_device()
                        try:
                            for p in self.vae.first_stage_model.parameters():
                                vae_restore_device = p.device
                                break
                            self.vae.first_stage_model.to(target_device)
                            taeltx = self.vae
                        except Exception as e:
                            logging.warning(f"[GJJ ModelPreviewOverride] Could not move TAEHV-LTX to GPU, skipping: {e}")
                    else:
                        # Comfy VAE.decode manages its own device — no pin-to-GPU needed.
                        ltx_full_vae = self.vae
                ltx_previewer = _LTXWrappedPreviewer(factors, bias, rate=8, taeltx=taeltx)
            except Exception as e:
                logging.warning(f"[GJJ ModelPreviewOverride] LTX previewer setup failed: {e}")

        previewer = _get_core_previewer(model_patcher.load_device, model_patcher.model.latent_format)
        # Latent2RGB fallback — used when the active previewer returns a non-PIL result
        # (e.g. TAEHV/TAESD on a 5D latent). LTX skips this and goes through ltx_previewer.
        fallback_previewer = None
        try:
            lf = model_patcher.model.latent_format
            rgb_factors = getattr(lf, "latent_rgb_factors", None)
            if rgb_factors is not None:
                fallback_previewer = latent_preview.Latent2RGBPreviewer(
                    rgb_factors,
                    getattr(lf, "latent_rgb_factors_bias", None),
                    getattr(lf, "latent_rgb_factors_reshape", None),
                )
        except Exception:
            pass

        original_callback = callback
        node_id = self.node_id
        max_res = self.max_resolution
        quality = self.jpeg_quality

        # N+1 boundaries for N steps: keep them all so the step marker advances through each.
        sigmas_list = sigmas.detach().cpu().tolist() if sigmas is not None else []
        # Pre-seed so step 1 has a measurable Δ (model's first transformation from noise → x0).
        initial_seed_cpu = None
        try:
            if sigmas is not None and len(sigmas) > 0:
                # sigmas often lives on CPU while noise is on CUDA — align before the multiply.
                s0 = sigmas[0].to(noise.device) if hasattr(sigmas[0], "to") else sigmas[0]
                seeded = noise * s0
                if is_ltx:
                    seeded = _normalize_ltx_x0(seeded, latent_shapes, num_keyframes)
                initial_seed_cpu = seeded.detach().float().cpu()
        except Exception as e:
            logging.warning(f"[GJJ ModelPreviewOverride] initial seed Δ pre-fill failed: {e}")
        state = {"last_x0_cpu": initial_seed_cpu, "last_time": None, "step_ms_window": []}
        total_steps_init = max(0, len(sigmas_list) - 1)

        # Boundary-0 message: sigmas (required by JS hover handler) plus optional noise preview.
        if node_id is not None and PromptServer is not None:
            init_payload = {
                "node_id": node_id,
                "step": 0,
                "total": total_steps_init,
                "sigma": sigmas_list[0] if sigmas_list else None,
                "sigmas": sigmas_list,
            }
            db_curve = _detect_detail_boost_curve(sampler, model_patcher, sigmas_list)
            if db_curve is not None:
                init_payload["db_curve"] = db_curve
            # Use Latent2RGB (or LTX previewer) directly — the model's default previewer (TAEHV)
            # slices to one temporal frame and returns a shape PIL can't render on raw noise.
            try:
                lf = model_patcher.model.latent_format
                rgb_factors = getattr(lf, "latent_rgb_factors", None)
                if sigmas is not None and len(sigmas) > 0:
                    s0 = sigmas[0].to(noise.device) if hasattr(sigmas[0], "to") else sigmas[0]
                    init_latent = noise * s0
                else:
                    init_latent = noise
                if is_ltx:
                    init_latent = _normalize_ltx_x0(init_latent, latent_shapes, num_keyframes)
                pil_init = None
                if ltx_previewer is not None and init_latent.ndim == 5:
                    pil_frames = _ltx_decode_to_pil(ltx_previewer, init_latent, max_frames=1)
                    pil_init = pil_frames[0] if pil_frames else None
                elif rgb_factors is not None:
                    noise_previewer = latent_preview.Latent2RGBPreviewer(
                        rgb_factors,
                        getattr(lf, "latent_rgb_factors_bias", None),
                        getattr(lf, "latent_rgb_factors_reshape", None),
                    )
                    out = noise_previewer.decode_latent_to_preview(init_latent)
                    if isinstance(out, Image.Image):
                        pil_init = out
                if pil_init is not None:
                    if pil_init.mode != "RGB":
                        pil_init = pil_init.convert("RGB")
                    if max_res and max_res > 0 and (pil_init.width > max_res or pil_init.height > max_res):
                        pil_init = ImageOps.contain(pil_init, (max_res, max_res), Image.LANCZOS)
                    ibuf = pyio.BytesIO()
                    pil_init.save(ibuf, format="JPEG", quality=quality)
                    init_payload["image"] = base64.b64encode(ibuf.getvalue()).decode("ascii")
                    init_payload["w"] = pil_init.width
                    init_payload["h"] = pil_init.height
            except Exception as e:
                logging.warning(f"Initial noise preview failed (sigmas still sent): {e}")
            PromptServer.instance.send_sync("gjj_model_preview_override", init_payload, PromptServer.instance.client_id)

        encoder = _AsyncPreviewEncoder()
        animate_video = self.preview_frames > 1
        anim_frames = self.preview_frames
        anim_fps = self.preview_fps


        def new_callback(step, x0, x, total_steps_):
            if previewer is not None or fallback_previewer is not None or ltx_previewer is not None:
                try:
                    # NEVER rebind x0 — the sampler reuses the same tensor downstream
                    # (unpack_latents reshapes it). Preview mutations stay on x0_view.
                    x0_view = x0
                    if is_ltx:
                        x0_view = _normalize_ltx_x0(x0_view, latent_shapes, num_keyframes)

                    pil_frames = []
                    max_pil = anim_frames if animate_video else 1
                    if ltx_full_vae is not None and x0_view.ndim == 5:
                        pil_frames = _ltx_full_vae_decode_to_pil(ltx_full_vae, x0_view, max_frames=max_pil)
                    if not pil_frames and ltx_previewer is not None and x0_view.ndim == 5:
                        try:
                            pil_frames = _ltx_decode_to_pil(ltx_previewer, x0_view, max_frames=max_pil)
                        except Exception as e:
                            logging.warning(f"LTX preview decode failed: {e}")
                    if not pil_frames and animate_video and x0_view.ndim == 5 and ltx_previewer is None:
                        pil_frames = _decode_video_frames_l2rgb(
                            x0_view, model_patcher.model.latent_format, anim_frames,
                        )

                    if not pil_frames:
                        for prev in (previewer, fallback_previewer):
                            if prev is None:
                                continue
                            try:
                                out = prev.decode_latent_to_preview(x0_view)
                            except Exception as e:
                                if prev is previewer:
                                    logging.warning(f"Active previewer raised, trying Latent2RGB fallback: {e}")
                                continue
                            if isinstance(out, Image.Image):
                                pil_frames = [out]
                                break
                            elif prev is previewer:
                                logging.warning(
                                    f"Preview override: {type(previewer).__name__} returned "
                                    f"{type(out).__name__} instead of PIL.Image — falling back to Latent2RGB."
                                )

                    if not pil_frames:
                        if original_callback is not None:
                            original_callback(step, x0, x, total_steps_)
                        return

                    pil_first = pil_frames[0]
                    if pil_first.mode != "RGB":
                        pil_first = pil_first.convert("RGB")
                        pil_frames[0] = pil_first

                    if node_id is not None and PromptServer is not None:
                        # x0_view (not x0) so LTX keyframe padding doesn't dampen the Δ norm.
                        x0_cpu_now = x0_view.detach().float().cpu()
                        prev_x0_cpu = state["last_x0_cpu"]
                        state["last_x0_cpu"] = x0_cpu_now

                        now = time.perf_counter()
                        step_ms = None
                        if state["last_time"] is not None:
                            step_ms = (now - state["last_time"]) * 1000.0
                            w = state["step_ms_window"]
                            w.append(step_ms)
                            if len(w) > 8:
                                w.pop(0)
                        state["last_time"] = now
                        avg_step_ms = (sum(state["step_ms_window"]) / len(state["step_ms_window"])) if state["step_ms_window"] else None
                        sigma_val = sigmas_list[step] if 0 <= step < len(sigmas_list) else None
                        sent_step = step + 1

                        def _encode_and_send(
                            pil_frames=pil_frames, x0_cpu_now=x0_cpu_now, prev_x0_cpu=prev_x0_cpu,
                            step_ms=step_ms, avg_step_ms=avg_step_ms, sigma_val=sigma_val,
                            sent_step=sent_step, total_steps_=total_steps_,
                        ):
                            if len(pil_frames) > 1:
                                # NVENC ~8x faster + ~5x smaller than PIL WebP when available.
                                b64, w_, h_, mime = None, 0, 0, None
                                if _NVENC_AVAILABLE:
                                    b64, w_, h_ = _encode_mp4_nvenc(pil_frames, anim_fps, max_res)
                                    if b64:
                                        mime = "video/mp4"
                                if not b64:
                                    b64, w_, h_ = _encode_animated_webp(pil_frames, anim_fps, quality, max_res)
                                    mime = "image/webp"
                            else:
                                pil_send = pil_frames[0]
                                if max_res and max_res > 0 and (pil_send.width > max_res or pil_send.height > max_res):
                                    pil_send = ImageOps.contain(pil_send, (max_res, max_res), Image.LANCZOS)
                                buf = pyio.BytesIO()
                                pil_send.save(buf, format="JPEG", quality=quality)
                                b64 = base64.b64encode(buf.getvalue()).decode("ascii")
                                w_, h_ = pil_send.width, pil_send.height
                                mime = "image/jpeg"

                            if not b64:
                                return

                            delta_v = None
                            if prev_x0_cpu is not None and prev_x0_cpu.shape == x0_cpu_now.shape:
                                diff = x0_cpu_now - prev_x0_cpu
                                delta_v = (diff.norm() / max(1, diff.numel()) ** 0.5).item()

                            PromptServer.instance.send_sync(
                                "gjj_model_preview_override",
                                {
                                    "node_id": node_id,
                                    "image": b64,
                                    "mime": mime,
                                    "w": w_,
                                    "h": h_,
                                    "step": sent_step,
                                    "total": total_steps_,
                                    "sigma": sigma_val,
                                    "sigmas": None,
                                    "delta": delta_v,
                                    "step_ms": step_ms,
                                    "avg_step_ms": avg_step_ms,
                                    "fps": anim_fps if mime in ("video/mp4", "image/webp") else None,
                                },
                                PromptServer.instance.client_id,
                            )

                        encoder.submit(_encode_and_send)
                except Exception as e:
                    logging.warning(f"Preview override failed: {e}")
            if original_callback is not None:
                original_callback(step, x0, x, total_steps_)

        # Patch every concrete decode_latent_to_preview_image — subclasses like VHS's
        # WrappedPreviewer override it and would otherwise still emit previews of their own.
        prev_methods = []
        if self.suppress_default:
            targets = [latent_preview.LatentPreviewer]
            stack = list(latent_preview.LatentPreviewer.__subclasses__())
            while stack:
                cls = stack.pop()
                targets.append(cls)
                stack.extend(cls.__subclasses__())
            for cls in targets:
                if "decode_latent_to_preview_image" in cls.__dict__:
                    prev_methods.append((cls, cls.__dict__["decode_latent_to_preview_image"]))
                    cls.decode_latent_to_preview_image = _suppressed_preview_image
        try:
            # Seeds step 1's duration measurement (sampling-start → end of step 1).
            state["last_time"] = time.perf_counter()
            return executor(noise, latent_image, sampler, sigmas, denoise_mask, new_callback, disable_pbar, seed, latent_shapes=latent_shapes)
        finally:
            encoder.shutdown(drain_timeout=5.0)
            for cls, prev in prev_methods:
                cls.decode_latent_to_preview_image = prev
            if vae_restore_device is not None and self.vae is not None:
                try:
                    self.vae.first_stage_model.to(vae_restore_device)
                except Exception:
                    pass


class GJJ_ModelPreviewOverrideKJ:
    CATEGORY = "GJJ/🧠 模型/采样"
    FUNCTION = "apply"
    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    OUTPUT_TOOLTIPS = ("已挂载高分辨率采样预览覆盖器的模型。",)
    DESCRIPTION = (
        "为模型挂载独立的采样过程预览面板，可提高预览分辨率、隐藏默认预览，"
        "并为视频 latent 生成动画预览和采样曲线。"
    )
    SEARCH_ALIASES = [
        "ModelPreviewOverrideKJ",
        "Model Preview Override KJ",
        "GJJ Model Preview Override",
        "模型预览覆盖",
        "采样预览覆盖",
        "高分辨率预览",
        "视频采样预览",
    ]
    GJJ_HELP = {
        "title": "模型采样预览覆盖 KJ",
        "version": "1.0.0",
        "description": DESCRIPTION,
        "features": [
            "独立显示采样中间结果，不受 ComfyUI 默认 512 像素预览上限影响。",
            "支持单帧 JPEG 预览和多帧 WebP/MP4 动画预览。",
            "显示 Sigma、Latent 变化量、单步耗时和预计剩余时间。",
            "内置 LTX、LTX2/LTXAV 预览系数，可选连接 LTX VAE 获得真彩预览。",
        ],
        "usage": [
            "把模型连接到本节点，再把输出模型连接到采样器或 Guider。",
            "图像模型建议将动画预览帧数保持为 1，以获得最低开销。",
            "视频模型可提高动画预览帧数，并用动画预览帧率控制播放速度。",
            "预览最大分辨率设为 0 时不缩放；高分辨率会增加传输与编码开销。",
        ],
        "notes": [
            "这是零外部节点依赖实现，不需要安装 ComfyUI-KJNodes。",
            "隐藏默认预览只影响采样预览图，不影响进度条。",
            "非 TAEHV 的完整 LTX VAE 每步解码较慢，仅在需要高质量预览时连接。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {
                    "display_name": "模型",
                    "tooltip": "要挂载采样预览覆盖器的模型。",
                }),
                "max_resolution": ("INT", {
                    "default": 1024, "min": 0, "max": 8192, "step": 8,
                    "display_name": "预览最大分辨率",
                    "tooltip": "预览图最长边的像素上限；0 表示保持采样原始分辨率，不缩小。",
                }),
                "jpeg_quality": ("INT", {
                    "default": 80, "min": 30, "max": 100, "step": 1,
                    "display_name": "JPEG质量",
                    "tooltip": "单帧预览传输使用的 JPEG 质量；越高越清晰，但数据量也越大。",
                }),
                "suppress_default_preview": ("BOOLEAN", {
                    "default": True,
                    "display_name": "隐藏默认预览",
                    "tooltip": "开启后隐藏采样器原生预览图，只更新本节点预览；采样进度条仍正常显示。",
                }),
                "preview_frames": ("INT", {
                    "default": 16, "min": 1, "max": 1024, "step": 1,
                    "display_name": "动画预览帧数",
                    "tooltip": "视频模型每个采样步骤抽取的预览帧数。默认 16 帧动态播放；设为 1 可切换为单帧预览并降低开销。",
                }),
                "preview_fps": ("INT", {
                    "default": 12, "min": 1, "max": 60, "step": 1,
                    "display_name": "动画预览帧率",
                    "tooltip": "动画预览的播放帧率；动画预览帧数为 1 时不生效。",
                }),
            },
            "optional": {
                "vae": ("VAE", {
                    "display_name": "LTX预览VAE",
                    "tooltip": "可选。TAEHV-LTX 可快速真彩预览；其它 LTX VAE 使用完整解码，每步耗时会明显增加。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def apply(
        self,
        model,
        max_resolution,
        jpeg_quality,
        suppress_default_preview,
        preview_frames,
        preview_fps,
        vae=None,
        unique_id=None,
    ):
        m = model.clone()
        m.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.OUTER_SAMPLE,
            "gjj_model_preview_override",
            _PreviewOverrideWrapper(
                max_resolution, unique_id, jpeg_quality, suppress_default_preview,
                preview_frames, preview_fps, vae,
            ),
        )
        return (m,)

NODE_CLASS_MAPPINGS = {
    "GJJ_ModelPreviewOverrideKJ": GJJ_ModelPreviewOverrideKJ,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_ModelPreviewOverrideKJ": "🔍 模型采样预览覆盖 KJ",
}
