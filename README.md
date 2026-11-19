# AJAZZ Web Driver

透過桌面瀏覽器調整 AJAZZ 滑鼠的 DPI、回報率、燈效與按鍵指派。這是社群開發的繁體中文 WebHID 工具。變更會直接寫入滑鼠，再從裝置讀回確認。模擬模式可以在沒有滑鼠時試用介面。

## 支援型號

| 型號 | 已實作的連線 | 功能與驗證狀態 |
| --- | --- | --- |
| AJ199 一般版 | USB、2.4 GHz | 已用實機驗證。支援 DPI 檔位增刪、X/Y 分軸、回報率、滾輪燈及按鍵配置。 |
| AJ179 PRO | USB、2.4 GHz、藍牙 | 依公開協定實作，尚待本專案實機驗證。支援 X/Y 分軸與各檔指示色，USB 最高 1000 Hz，2.4 GHz 接收器提供最高 8000 Hz 的設定。 |
| AJ179 V2 MAX | USB、2.4 GHz | 依公開協定實作，尚待本專案實機驗證。提供六個 DPI 儲存位置、X/Y 同步、機身燈效及移動同步。修改 DPI 檔色請使用 USB。 |

頁面會依裝置實際回報的型號選擇通訊協定與產品照。照片配色是外觀示意。六鍵配置儲存在目前瀏覽器，各型號分開管理。

## 在本機使用

需要 Python 3 和支援 WebHID 的桌面版 Chrome 或 Edge。下載專案後，在含有 `index.html` 的目錄啟動靜態伺服器。

```sh
python -m http.server 8000 --bind 127.0.0.1
```

- **連接實機**　開啟 [本機設定頁](http://127.0.0.1:8000/)，按「連接滑鼠」並在瀏覽器選擇裝置。修改後可在頁面下方查看寫入與讀回結果。
- **試用介面**　開啟 [模擬模式](http://127.0.0.1:8000/?mode=demo)，從「預覽型號」選擇滑鼠。此模式使用範例資料。

專案使用原生 HTML、CSS 與 JavaScript，可直接由靜態伺服器提供。自行架站時請使用 HTTPS，讓瀏覽器開放 WebHID。

## 協定與圖片來源

- AJ199 的通訊與燈效參考 [OpenAjazz](https://github.com/taylors42/OpenAjazz/blob/main/docs/POC.md) 和 [ajazz-linux 的實機紀錄](https://github.com/a32fred/ajazz-linux/blob/main/docs/reference/HARDWARE_FINDINGS.md)。
- AJ179 PRO 參考 [OpenMouse 的 AJ179 PRO 協定](https://github.com/OpenMouse-Project/mouse-protocol/blob/main/docs/ajazz-aj179-pro.md)。
- AJ179 V2 MAX 參考 [Ajazzy 的封包與讀回紀錄](https://github.com/Geovane2dd/Ajazzy/blob/main/docs/reverse-engineering.md)。

產品照片由外部圖源提供。若要離線顯示，可建立 `assets/` 目錄，把以下圖片存成表內的檔名。頁面會優先使用本機檔案。

| 型號 | 本機檔名 | 來源 |
| --- | --- | --- |
| AJ199 白色 | `aj199-white.jpg` | [產品照片](https://cdn.shopify.com/s/files/1/0726/8528/9780/files/9_a2300fdc-7486-48b1-a5f4-0f788a1109ca.jpg?v=1714017706&width=940) |
| AJ179 PRO | `aj179-pro.png` | [GearDB 產品照片](https://geardb.cn/api/v1/images/85c443a1-26b9-45e1-b274-58c2ad840c78.png) |
| AJ179 V2 MAX | `aj179-v2-max.png` | [GearDB 產品照片](https://geardb.cn/api/v1/images/9b3ab62a-8a6f-466e-a0c3-9a0a9fc5970f.png) |

## 授權

程式碼與本專案文件採用 [MIT License](LICENSE)。產品照片與商標的權利屬於各自權利人。
