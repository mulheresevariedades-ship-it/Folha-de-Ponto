from statistics import mode, median, mean

from pathlib import Path
from paddleocr import PaddleOCR

BASE_DIR = Path(__file__).resolve().parent

class ocr:
    def __init__(self):
        self.__CAMINHO = BASE_DIR / "imgs" / "editadas"
    def buscarImagem(self):
        imagens = list(self.__CAMINHO.glob("*.png"))
        for i, imagem in enumerate(imagens):
            print(f"{i} - {imagem.name}")
        var = int(input())
        option = imagens[var]
        return option
    def VerivicarImg(self):
        try:
            ocr = PaddleOCR(
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                lang='pt',
                engine='paddle',
                enable_mkldnn=False,
            )
            results = ocr.predict(str(self.__CAMINHO / self.buscarImagem()))
            for res in results:
                textos = res["rec_texts"]
                confiancas = res["rec_scores"]

                for texto, confianca in zip(textos, confiancas):
                    print(f"[{confianca:.3f}] {texto}")

                res.save_to_img("output")
                res.save_to_json("output")

            confianca_arredondada = [
                round(valor,3)
                for valor in confiancas
            ]
            moda = mode(confianca_arredondada)
            media = mean(confiancas)
            mediana = median(confiancas)

            print(f"Moda: {moda:.4f}")
            print(f"Média: {media:.4f}")
            print(f"Mediana: {mediana:.4f}")
        except NameError:
            print(NameError)
            pass

obj = ocr()
print(obj.VerivicarImg())