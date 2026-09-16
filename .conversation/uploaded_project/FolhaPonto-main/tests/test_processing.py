import unittest

from FolhaPontoBack.processing import extract_fields


class ProcessingTests(unittest.TestCase):
    def test_extracts_fields_from_undf_form(self):
        result = extract_fields(
            "REGISTRO DE FREQUÊNCIA\n"
            "REFERÊNCIA: JULHO/2026\n"
            "MATRÍCULA: 17289106\n"
            "NOME DO SERVIDOR: ALEXANDRE NATA VICENTE\n"
        )
        self.assertEqual(result.matricula, "17289106")
        self.assertEqual(result.nome, "ALEXANDRE NATA VICENTE")
        self.assertEqual(result.competencia, "JULHO/2026")
        self.assertGreaterEqual(result.confianca, 0.9)

    def test_low_confidence_is_explicit_when_no_text_is_found(self):
        result = extract_fields("")
        self.assertIsNone(result.matricula)
        self.assertEqual(result.modo, "ocr-indisponivel")
        self.assertLess(result.confianca, 0.7)


if __name__ == "__main__":
    unittest.main()