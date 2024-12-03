// Select all buttons with the class 'item-button'
const buttons = document.querySelectorAll<HTMLButtonElement>('.item-button');

// Add click event listener to each button
buttons.forEach((button) => {
    button.addEventListener('click', () => {
        // Example action: Log the button's text content
        console.log(`Button ${button.textContent} clicked`);
        
        // Example: Toggle between 'X' and 'O'
        if (button.textContent === 'X' || button.textContent === 'O') {
            // Do nothing or reset
            return;
        }
        button.textContent = 'X'; // Or implement game logic to alternate
    });
});