// server.js
import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Payment } from 'mercadopago';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

let oauthCredentials = { access_token: null };

// Rota OAuth (igual ao que você já tinha)
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

// ROTA PRINCIPAL - PROCESSAR PAGAMENTO (com validação e logs)
app.post('/process_payment', async (req, res) => {
  try {
    // Escolhe o token (prioriza OAuth, senão usa variável de ambiente)
    let accessToken = oauthCredentials.access_token || process.env.MP_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(500).json({ error: 'Token de acesso não configurado' });
    }

    const { transaction_amount, description, payment_method_id, payer } = req.body;

    // VALIDAÇÃO CRÍTICA: PIX exige email do comprador
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

    // Se for cartão, adiciona token (não usado no PIX)
    if (req.body.token && (payment_method_id === 'credit_card' || payment_method_id === 'debit_card')) {
      paymentData.token = req.body.token;
      if (req.body.installments) paymentData.installments = req.body.installments;
    }

    console.log('📤 Enviando para MP:', JSON.stringify(paymentData, null, 2));

    const response = await payment.create({ body: paymentData });
    console.log('✅ Resposta do MP:', JSON.stringify(response, null, 2));

    // Prepara resposta para o frontend
    const result = {
      id: response.id,
      status: response.status,
      status_detail: response.status_detail,
      order_number: '#' + String(response.id).slice(-6),
      transaction_amount: response.transaction_amount
    };

    // Inclui dados do PIX se existirem
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