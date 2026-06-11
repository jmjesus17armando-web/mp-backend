// server.js
import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Payment } from 'mercadopago';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// ========================
// CREDENCIAIS OAuth EM MEMÓRIA
// ========================
let oauthCredentials = {
  access_token: null,
  public_key: null,
  refresh_token: null,
  expires_in: null,
  user_id: null
};

// ========================
// ROTA 1: OAuth Callback
// ========================
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Código de autorização não fornecido' });
  }

  try {
    const response = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        client_id: process.env.MP_CLIENT_ID,
        client_secret: process.env.MP_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: `${process.env.BACKEND_URL || 'https://mp-backend-production-0e4a.up.railway.app'}/oauth/callback`
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Erro na troca do code:', data);
      return res.status(response.status).json({ error: data.error_description || 'Falha na autenticação' });
    }

    oauthCredentials = {
      access_token: data.access_token,
      public_key: data.public_key,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      user_id: data.user_id
    };

    console.log('Credenciais OAuth armazenadas com sucesso!');

    res.send(`
      <h1>✅ Integração concluída!</h1>
      <p>As credenciais do seu cliente foram salvas. Agora você pode fechar esta janela.</p>
      <script>setTimeout(() => window.close(), 3000);</script>
    `);
  } catch (error) {
    console.error('Erro no callback OAuth:', error);
    res.status(500).json({ error: 'Erro interno ao processar autorização' });
  }
});

// ========================
// ROTA 2: Obter credenciais salvas
// ========================
app.get('/oauth/credentials', (req, res) => {
  if (!oauthCredentials.access_token) {
    return res.status(404).json({ error: 'Nenhuma credencial OAuth encontrada. Faça a autorização primeiro.' });
  }

  res.json({
    access_token: oauthCredentials.access_token,
    public_key: oauthCredentials.public_key,
    expires_in: oauthCredentials.expires_in,
    user_id: oauthCredentials.user_id
  });
});

// ========================
// ROTA 3: Processar pagamento
// ========================
app.post('/process_payment', async (req, res) => {
  try {
    const accessToken = oauthCredentials.access_token || process.env.MP_ACCESS_TOKEN;

    if (!accessToken) {
      return res.status(500).json({ error: 'Nenhum token de acesso configurado' });
    }

    const client = new MercadoPagoConfig({ accessToken });
    const payment = new Payment(client);

    const { token, transaction_amount, description,
            payment_method_id, payer, installments } = req.body;

    const paymentData = {
      transaction_amount: Number(transaction_amount),
      description: description || 'Pedido Marketplace Aliança',
      payment_method_id: payment_method_id,
      payer: payer,
      installments: installments || 1,
    };

    // Token só existe pra cartão — PIX e boleto não têm token
    if (token) paymentData.token = token;

    const response = await payment.create({ body: paymentData });
    console.log('Resposta MP:', JSON.stringify(response, null, 2));

    // Retorna resposta limpa com point_of_interaction para PIX/boleto
    res.status(201).json({
      id: response.id,
      status: response.status,
      status_detail: response.status_detail,
      order_number: '#' + String(response.id).slice(-6),
      point_of_interaction: response.point_of_interaction || null,
      transaction_details: response.transaction_details || null,
      transaction_amount: response.transaction_amount,
    });

  } catch (error) {
    console.error('Erro ao processar pagamento:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// INICIA SERVIDOR
// ========================
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
