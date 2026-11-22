export const verticals = {
  restaurant: {
    name: 'Restaurant', sections: [
      { title: 'Menu and dietary options', type: 'faq', text: 'Add the current menu URL and options the kitchen can confirm.' },
      { title: 'Hours and reservations', type: 'faq', text: 'Add your confirmed hours, location, and reservation contact.' },
      { title: 'Service guidance', type: 'instructions', text: 'Use only confirmed hours and availability. For allergies, ask guests to confirm directly with the restaurant.' }
    ]
  },
  artist: {
    name: 'Artist', sections: [
      { title: 'Biography and work', type: 'faq', text: 'Add a short biography, repertoire or selected work and public portfolio links.' },
      { title: 'Bookings and press', type: 'faq', text: 'Add public booking and press contacts.' },
      { title: 'Availability', type: 'instructions', text: 'Refer booking and audition invitations to the listed contact. Do not promise availability.' }
    ]
  },
  athlete: {
    name: 'Athlete', sections: [
      { title: 'Profile and calendar', type: 'faq', text: 'Add public results, confirmed tournaments and the athlete’s portfolio.' },
      { title: 'Partnerships', type: 'faq', text: 'Add the sponsor information and public partnership contact.' },
      { title: 'Results and calendar guidance', type: 'instructions', text: 'Use verified results and distinguish provisional dates from confirmed dates.' }
    ]
  }
};
