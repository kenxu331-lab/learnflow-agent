import "./style.css";

const status = document.querySelector<HTMLElement>("#status");

if (status) {
  status.textContent = "Environment Ready";
}
