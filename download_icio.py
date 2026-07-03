import pymrio
from pathlib import Path

oecd_storage = Path("./OECD_ICIO")
oecd_storage.mkdir(exist_ok=True)

# 先用2018年验证流程走得通
meta = pymrio.download_oecd(storage_folder=oecd_storage, years=[2018])
io = pymrio.parse_oecd(path=oecd_storage, year=2018)

io.calc_all()

print("国家/地区列表:", io.get_regions())
print("行业列表:", io.get_sectors())
print("里昂惕夫逆矩阵形状:", io.L.shape)

# 保存中间结果方便后续分析
io.L.to_csv(oecd_storage / "leontief_inverse_2018.csv")
