// server.js
import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Payment } from 'mercadopago';

const app = express();
const PORT = process.env.PORT || 3000;

// Permite receber JSON do frontend
app.use(express.json());
// Permite que seu site no Netlify chame este backend
app.use(cors());

// Endpoint que o Mercado Pago Brick vai chamar
app.post('/process_payment', async (req, res) => {
  try {
    // Dados enviados pelo Brick
    const { token, transaction_amount, description, payment_method_id, payer } = req.body;

    // Configura o cliente do Mercado Pago com o token secreto (do ambiente)
    const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const payment = new Payment(client);

    // Monta o pagamento
    const paymentData = {
      transaction_amount: transaction_amount,
      description: description,
      payment_method_id: payment_method_id,
      payer: payer,
      token: token,
      installments: 1,
    };

    // Envia para a API do Mercado Pago
    const response = await payment.create({ body: paymentData });

    // Devolve a resposta para o site
    res.status(201).json(response);
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));