import { parseAccountClosed } from './event-consumer.service';
import { PoisonMessageError } from './retry-policy';

describe('account.closed en compliance: validación del contenido', () => {
  const valid = {
    idUser: '11111111-1111-4111-8111-111111111111',
    cerradaEn: '2026-10-20T15:00:00.000Z',
    cuentas: ['4001234567', '4007654321'],
  };

  it('acepta el evento que publica account-service', () => {
    expect(parseAccountClosed(valid)).toEqual({
      idUser: valid.idUser,
      closedAt: new Date(valid.cerradaEn),
      accounts: valid.cuentas,
    });
  });

  it('sin cuentas o con valores raros, guarda solo los textos', () => {
    expect(parseAccountClosed({ ...valid, cuentas: undefined }).accounts).toEqual([]);
    expect(parseAccountClosed({ ...valid, cuentas: ['4001234567', 7, null] }).accounts).toEqual(['4001234567']);
  });

  it.each([
    ['sin idUser', { ...valid, idUser: undefined }],
    ['idUser que no es UUID', { ...valid, idUser: 'abc' }],
    ['sin fecha', { ...valid, cerradaEn: undefined }],
    ['fecha inválida', { ...valid, cerradaEn: 'ayer' }],
    ['sin datos', undefined],
  ])('%s: va directo a la DLQ', (_caso, data) => {
    expect(() => parseAccountClosed(data)).toThrow(PoisonMessageError);
  });
});
