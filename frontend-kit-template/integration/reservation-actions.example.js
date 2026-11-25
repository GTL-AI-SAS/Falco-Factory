/** Adapt this example to the site's EXISTING API client. */
export const reservationAction = {
  id:'reservation.create',
  description:'Crear una reserva con el nombre y la fecha solicitados. Pregunta por los datos que falten.',
  requiresConfirmation:true,
  parameters:{
    name:{type:'string',minLength:2,maxLength:100,description:'Nombre de la persona que reserva'},
    date:{type:'date',description:'Fecha de la reserva en formato YYYY-MM-DD'}
  },
  resultFields:['reservationId','date']
};
export function reservationHandlers(api) {
  return {
    'reservation.create':async ({name,date},{idempotencyKey,signal}) => {
      // The host API client owns authentication, CSRF, retries and backend errors.
      const result = await api.createReservation({name,date},{idempotencyKey,signal});
      if (!result.ok) return {ok:false,code:'reservation_unavailable',message:'No se pudo reservar esa fecha.'};
      // Public projection only: never return a raw response, headers, credentials or exception.
      return {ok:true,data:{reservationId:result.reservationId,date:result.date},message:'Reserva confirmada.'};
    }
  };
}
