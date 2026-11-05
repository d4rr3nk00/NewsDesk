document.querySelector('#login').addEventListener('submit', event => {
  event.preventDefault();
  window.desk.credentials({username:document.querySelector('#username').value,password:document.querySelector('#password').value});
});
