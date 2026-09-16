import cv2
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
# __CAMINHO = BASE_DIR / "imgs" / "originais"
# __IMAGEM = cv2.imread(str(__CAMINHO))
# print(__IMAGEM.shape)

class Img:
    def __init__(self):
        self.__CAMINHO = self.__caminha()
        self.obj = self.__carregadorImagem()
        # self.nome = ""
        self.__arquivo = "teste"
        self.cor = "colorado"
        self.xy = 0
        self.ab = [0, 0]
        self.x = 0

    def buscarImagem(self):
        imagens = list(self.__CAMINHO.glob("*.png"))
        print("Manda a imagem patrão")
        for i, imagem in enumerate(imagens):
            print(f"{i} - {imagem.name}")
        var = int(input())
        option = imagens[var]
        self.__arquivo = str(option)
        return option
    
    def __caminha(self):
        return BASE_DIR / "imgs" / "originais"

    def __carregadorImagem(self):
        return cv2.imread(str(self.__CAMINHO / self.buscarImagem()))
    
    def img(self):
        self.x = str(input("1 - Ampliar a imagem \n2 - alterar o brilho/contraste \n3 - alterar a cor da imagem \n"))
        match self.x:
            case '1':
                try:
                    self.xy = float(input("\nGrau de ampliação? "))
                    imagem_maior = cv2.resize(
                                self.obj,
                                None,
                                fx=self.xy,
                                fy=self.xy,
                                interpolation=cv2.INTER_CUBIC
                            )
                    self.obj = imagem_maior
                    print("Ampliado")
                except Exception as erro:
                    print(erro)
                finally: 
                    self.img()
            case '2':
                try:
                    self.ab[0] = float(input("\nQual a alfa? "))
                    self.ab[1] = float(input("\nQual o beta? "))
                    imagem_contraste = cv2.convertScaleAbs(
                        self.obj,
                        alpha = 1 + self.ab[0]/10,
                        beta = self.ab[1], 
                    )
                    self.obj = imagem_contraste
                    print("Contrastado")
                except Exception as erro:
                    print(erro)
                finally: 
                    self.img()

            case '3':
                try:
                    self.cor = "descolorado"
                    imagem_cor = cv2.cvtColor(obj, cv2.COLOR_BGR2GRAY)
                    self.obj = imagem_cor
                    print("Colorado")
                except Exception as erro:
                    print(erro)
                finally: 
                    self.img()
            case _:
                print("Passou nada paizão!")

    def execute(self):
        self.img()
        if self.xy != 0:
            self.__arquivo += f"_x{float(self.xy)}"
        if self.ab[0]!=0 or self.ab[1] !=0 :
            self.__arquivo += f"_ab{float(self.ab[0])}_{float(self.ab[1])}"
        if self.cor != "colorado":
            self.__arquivo += f"_{self.cor}"

        caminho_saida = BASE_DIR / "imgs" / "editadas" / f"{self.__arquivo}.png"
        cv2.imwrite(str(caminho_saida), self.obj)

obj = Img()
obj.execute()