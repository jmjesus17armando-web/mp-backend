// server.js
import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Payment } from 'mercadopago';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

let oauthCredentials = { access_token: null };

// =======================================================
// TABELA DE FRETE FIXA POR ESTADO (substitui a API dos Correios)
// A API gratuita dos Correios (CalcPrecoPrazo) foi descontinuada
// em 30/09/2023 e só funciona para quem tem contrato ativo.
// =======================================================

// Mapeia os 2 primeiros dígitos do CEP para a UF
function getUFByCep(cep) {
    const prefix = parseInt(cep.substring(0, 2));
    const ranges = [
        { uf: 'SP', min: 1, max: 19 },
        { uf: 'RJ', min: 20, max: 28 },
        { uf: 'ES', min: 29, max: 29 },
        { uf: 'MG', min: 30, max: 39 },
        { uf: 'BA', min: 40, max: 48 },
        { uf: 'SE', min: 49, max: 49 },
        { uf: 'PE', min: 50, max: 56 },
        { uf: 'AL', min: 57, max: 57 },
        { uf: 'PB', min: 58, max: 58 },
        { uf: 'RN', min: 59, max: 59 },
        { uf: 'CE', min: 60, max: 63 },
        { uf: 'PI', min: 64, max: 64 },
        { uf: 'MA', min: 65, max: 65 },
        { uf: 'PA', min: 66, max: 68 },
        { uf: 'AP', min: 68, max: 68 },
        { uf: 'AM', min: 69, max: 69 },
        { uf: 'RR', min: 69, max: 69 },
        { uf: 'AC', min: 69, max: 69 },
        { uf: 'DF', min: 70, max: 73 },
        { uf: 'GO', min: 72, max: 76 },
        { uf: 'RO', min: 76, max: 76 },
        { uf: 'TO', min: 77, max: 77 },
        { uf: 'MT', min: 78, max: 78 },
        { uf: 'MS', min: 79, max: 79 },
        { uf: 'PR', min: 80, max: 87 },
        { uf: 'SC', min: 88, max: 89 },
        { uf: 'RS', min: 90, max: 99 },
    ];
    const found = ranges.find(r => prefix >= r.min && prefix <= r.max);
    return found ? found.uf : null;
}

// Tabela de preços por região (AJUSTE os valores conforme sua realidade)
const FREIGHT_TABLE = {
    SP: { region: 'São Paulo', price: 15.00, days: 3 },
    SUDESTE: { region: 'Sudeste (RJ, MG, ES)', price: 25.00, days: 5, ufs: ['RJ', 'MG', 'ES'] },
    SUL: { region: 'Sul (PR, SC, RS)', price: 30.00, days: 6, ufs: ['PR', 'SC', 'RS'] },
    OUTROS: { region: 'Demais regiões do Brasil', price: 40.00, days: 10 } // fallback
};

function getFreightByUF(uf) {
    if (uf === 'SP') return FREIGHT_TABLE.SP;
    if (FREIGHT_TABLE.SUDESTE.ufs.includes(uf)) return FREIGHT_TABLE.SUDESTE;
    if (FREIGHT_TABLE.SUL.ufs.includes(uf)) return FREIGHT_TABLE.SUL;
    return FREIGHT_TABLE.OUTROS;
}

app.post('/calculate_shipping', async (req, res) => {
    try {
        const { destinationZip } = req.body;

        if (!destinationZip) {
            return res.status(400).json({ error: "CEP de destino ausente." });
        }

        const cep = destinationZip.replace(/\D/g, '');
        if (cep.length !== 8) {
            return res.status(400).json({ error: "CEP inválido." });
        }

        const uf = getUFByCep(cep);
        if (!uf) {
            return res.status(400).json({ error: "Não foi possível identificar o estado para este CEP." });
        }

        const freight = getFreightByUF(uf);

        res.json({
            options: [
                {
                    type: 'ENTREGA',
                    price: freight.price.toFixed(2).replace('.', ','),
                    days: freight.days,
                    region: freight.region
                }
            ]
        });

    } catch (error) {
        console.error('Erro ao calcular frete:', error);
        res.status(500).json({ error: "Erro interno ao calcular frete." });
    }
});

// =======================================================
// ROTAS ORIGINAIS (OAuth e Pagamento)
// =======================================================

// Rota OAuth
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Código não fornecido' });
  try {
    const response = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.MP_CLIENT_ID,
        client_secret: process.env.MP_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: `${process.env.BACKEND_URL}/oauth/callback`
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error_description);
    oauthCredentials.access_token = data.access_token;
    res.send('<h1>✅ OAuth concluído! Feche esta janela.</h1><script>window.close()</script>');
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ROTA PRINCIPAL - PROCESSAR PAGAMENTO
app.post('/process_payment', async (req, res) => {
  try {
    let accessToken = oauthCredentials.access_token || process.env.MP_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(500).json({ error: 'Token de acesso não configurado' });
    }

    const { transaction_amount, description, payment_method_id, payer } = req.body;

    if (payment_method_id === 'pix' && (!payer || !payer.email)) {
      return res.status(400).json({ error: 'E-mail do comprador é obrigatório para PIX' });
    }

    const client = new MercadoPagoConfig({ accessToken });
    const payment = new Payment(client);

    const paymentData = {
      transaction_amount: Number(transaction_amount),
      description: description || 'Pedido Marketplace Aliança',
      payment_method_id: payment_method_id,
      payer: {
        email: payer.email,
        first_name: payer.first_name || '',
        last_name: payer.last_name || '',
        identification: payer.identification || { type: 'CPF', number: '' },
        phone: payer.phone || { area_code: '', number: '' },
        address: payer.address || {}
      }
    };

    if (req.body.token && (payment_method_id === 'credit_card' || payment_method_id === 'debit_card')) {
      paymentData.token = req.body.token;
      if (req.body.installments) paymentData.installments = req.body.installments;
    }

    console.log('📤 Enviando para MP:', JSON.stringify(paymentData, null, 2));

    const response = await payment.create({ body: paymentData });
    console.log('✅ Resposta do MP:', JSON.stringify(response, null, 2));

    const result = {
      id: response.id,
      status: response.status,
      status_detail: response.status_detail,
      order_number: '#' + String(response.id).slice(-6),
      transaction_amount: response.transaction_amount
    };

    if (response.point_of_interaction) {
      result.point_of_interaction = response.point_of_interaction;
    }
    if (response.transaction_details) {
      result.transaction_details = response.transaction_details;
    }

    res.status(201).json(result);
  } catch (error) {
    console.error('❌ Erro no backend:', error);
    res.status(500).json({ error: error.message, details: error.cause?.body });
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
